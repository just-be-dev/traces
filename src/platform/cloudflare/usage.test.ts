import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { entryTrace, type IngestBatch } from "../../ingest.ts";
import { Owner, type Trace, TraceStore } from "../../traces.ts";
import {
  aggregate,
  recordPendingUsage,
  USAGE_BATCH_SIZE,
  USAGE_EVENTS,
  UsageStore,
  usageOf,
} from "../../usage.ts";
import { sqliteD1 } from "./d1.testing.ts";
import { storage } from "./traces.ts";
import { offsetModifier, usage } from "./usage.ts";

const owner = Owner.make("owner");

const transcript = (
  harness: IngestBatch["client"]["harness"],
  raws: ReadonlyArray<unknown>,
  session = "session-1",
): Array<Trace> => {
  const batch: IngestBatch = {
    client: { harness, uploaderVersion: "1" },
    session: { id: session, stream: session },
    entries: raws.map((raw, offset) => ({
      offset,
      raw: raw as IngestBatch["entries"][number]["raw"],
    })),
  };
  return batch.entries.map((entry) => entryTrace(owner, batch, entry, "2026-10-01T00:00:00Z"));
};

const claude = (uuid: string, messageId: string, timestamp: string, tool?: string) => ({
  type: "assistant",
  uuid,
  timestamp,
  message: {
    id: messageId,
    model: "claude-opus-5-5",
    content: [tool ? { type: "tool_use", name: tool } : { type: "text" }],
    usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3 },
  },
});
const codexContext = (ordinal: number, model: string) => ({
  timestamp: "2026-10-12T22:25:50Z",
  ordinal,
  type: "turn_context",
  payload: { model },
});
const codexTokens = (ordinal: number, total: number) => ({
  timestamp: "2026-10-12T22:26:00Z",
  ordinal,
  type: "event_msg",
  payload: {
    type: "token_count",
    info: {
      total_token_usage: { total_tokens: total },
      last_token_usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 1 },
    },
  },
});

const setup = async () => {
  const { db, d1 } = await sqliteD1();
  const layer = Layer.mergeAll(storage(Effect.succeed(d1)), usage(Effect.succeed(d1)));
  const run = <A, E>(effect: Effect.Effect<A, E, TraceStore | UsageStore>) =>
    Effect.runPromise(effect.pipe(Effect.provide(layer)));
  const insert = (traces: ReadonlyArray<Trace>) =>
    run(
      Effect.gen(function* () {
        const store = yield* TraceStore;
        return yield* store.insertMany(traces);
      }),
    );
  return { db, run, insert };
};

test("offset modifiers are signed minutes", () => {
  expect(offsetModifier(-240)).toBe("-240 minutes");
  expect(offsetModifier(330)).toBe("+330 minutes");
});

test("the D1 sweep backfills, dedups, inherits Codex models, and only moves forward", async () => {
  const { db, run, insert } = await setup();
  await insert([
    ...transcript("claude-code", [
      claude("a", "msg_1", "2026-10-11T18:00:00Z"),
      claude("b", "msg_1", "2026-10-11T18:00:01Z", "Read"),
      { type: "user", uuid: "c", message: { content: "hi" } },
    ]),
    ...transcript("codex", [codexContext(1, "gpt-5.5"), codexTokens(2, 10)], "codex-1"),
  ]);
  expect(await run(recordPendingUsage())).toEqual({ scanned: 4, projected: 3 });
  // A later upload of the same Codex session starts mid-turn.
  await insert(transcript("codex", [codexTokens(3, 20), codexTokens(4, 20)], "codex-1"));
  expect(await run(recordPendingUsage())).toEqual({ scanned: 2, projected: 2 });
  expect(await run(recordPendingUsage())).toEqual({ scanned: 0, projected: 0 });

  const rows = db
    .query("SELECT key, model, input_tokens, cache_read_tokens FROM usage_records ORDER BY key")
    .all();
  expect(rows).toEqual([
    { key: "claude-code:msg_1", model: "claude-opus-5-5", input_tokens: 1, cache_read_tokens: 3 },
    { key: "codex:codex-1:total=10", model: "gpt-5.5", input_tokens: 6, cache_read_tokens: 4 },
    { key: "codex:codex-1:total=20", model: "gpt-5.5", input_tokens: 6, cache_read_tokens: 4 },
  ]);
  const cursor = db.query("SELECT cursor FROM usage_sweep").get() as { cursor: number };
  const head = db.query("SELECT MAX(rowid) AS head FROM events").get() as { head: number };
  expect(cursor.cursor).toBe(head.head);

  // An overlapping run that finishes later with an older cursor can't move it back.
  await run(
    Effect.gen(function* () {
      const store = yield* UsageStore;
      return yield* store.record([], 1 as never);
    }),
  );
  expect(db.query("SELECT cursor FROM usage_sweep").get()).toEqual({ cursor: head.head });
});

test("the D1 sweep skips non-usage rows without reading them and honors limit and byte budget", async () => {
  const { db, run, insert } = await setup();
  await insert(
    transcript(
      "claude-code",
      Array.from({ length: USAGE_BATCH_SIZE + 2 }, (_, index) =>
        index % 2 === 0
          ? claude(`a${index}`, `msg_${index}`, "2026-10-11T18:00:00Z")
          : { type: "user", uuid: `u${index}`, message: { content: "x" } },
      ),
    ),
  );
  const first = await run(
    Effect.gen(function* () {
      const store = yield* UsageStore;
      return yield* store.backlog(USAGE_BATCH_SIZE, 8_000_000);
    }),
  );
  expect(first.traces).toHaveLength(Math.ceil((USAGE_BATCH_SIZE + 2) / 2));
  const head = db.query("SELECT MAX(rowid) AS head FROM events").get() as { head: number };
  expect(first.cursor).toBe(head.head as never);

  const tight = await run(
    Effect.gen(function* () {
      const store = yield* UsageStore;
      return yield* store.backlog(2, 1);
    }),
  );
  // The first candidate always fits; the cursor stops at the last returned row.
  expect(tight.traces).toHaveLength(1);
  expect(tight.cursor).toBe(1 as never);
  expect<ReadonlyArray<string>>(USAGE_EVENTS).toContain(String(tight.traces[0]?.event));
});

test("D1 aggregation matches the reference aggregation, by local day and hour", async () => {
  const { run, insert } = await setup();
  const traces = [
    ...transcript("claude-code", [
      claude("a", "msg_1", "2026-10-11T03:30:00Z", "Read"),
      claude("b", "msg_2", "2026-10-11T18:00:00Z", "Bash"),
      claude("c", "msg_3", "2026-10-11T19:00:00Z", "Read"),
    ]),
    ...transcript("codex", [codexContext(1, "gpt-5.5"), codexTokens(2, 10)], "codex-1"),
    ...transcript("pi", [
      {
        type: "message",
        id: "p",
        timestamp: "2025-01-01T00:00:00Z",
        message: { role: "assistant", usage: { input: 5 } },
      },
    ]),
  ];
  await insert(traces);
  await run(recordPendingUsage());
  const since = "2026-01-01T04:00:00.000Z";
  const result = await run(
    Effect.gen(function* () {
      const store = yield* UsageStore;
      return yield* store.aggregate(owner, since, -240);
    }),
  );
  const expected = aggregate(
    usageOf(traces).filter((record) => record.occurredAt >= since),
    -240,
  );
  expect(result).toEqual(expected);
  expect(result.days.map((day) => day.day)).toEqual(["2026-10-10", "2026-10-11", "2026-10-12"]);
});

test("D1 snapshots round-trip, keep the newer write, and read unparseable rows as missing", async () => {
  const { db, run } = await setup();
  const snapshot = (generatedAt: string, marker: string) => ({
    stats: { marker } as never,
    generatedAt,
    cursor: 3,
  });
  const read = () =>
    run(
      Effect.gen(function* () {
        const store = yield* UsageStore;
        return yield* store.readSnapshot(owner);
      }),
    );
  const write = (value: ReturnType<typeof snapshot>) =>
    run(
      Effect.gen(function* () {
        const store = yield* UsageStore;
        yield* store.writeSnapshot(owner, value);
      }),
    );
  expect(Option.isNone(await read())).toBe(true);
  await write(snapshot("2026-10-14T12:00:00.000Z", "new"));
  await write(snapshot("2026-10-14T11:00:00.000Z", "old"));
  expect(Option.getOrThrow(await read())).toEqual(snapshot("2026-10-14T12:00:00.000Z", "new"));
  await write(snapshot("2026-10-14T12:05:00.000Z", "newer"));
  expect(Option.getOrThrow(await read())).toMatchObject({ stats: { marker: "newer" } });
  db.run("UPDATE usage_snapshots SET snapshot = 'not json'");
  expect(Option.isNone(await read())).toBe(true);
  expect(
    await run(
      Effect.gen(function* () {
        const store = yield* UsageStore;
        return yield* store.position;
      }),
    ),
  ).toBe(0 as never);
});
