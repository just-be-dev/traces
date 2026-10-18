import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as Schema from "effect/Schema";
import { Identity, Owner, type Trace, TraceStore } from "./traces.ts";
import { entryTrace, type IngestBatch } from "./ingest.ts";
import {
  aggregate,
  recordPendingUsage,
  statsWindow,
  traceUsage,
  USAGE_BATCH_SIZE,
  UsageStore,
  usageOf,
  publicUsageStats,
  refreshUsageStats,
  Showcase,
  SNAPSHOT_REFRESH_MS,
  StatsSnapshot,
  TimeZone,
  utcOffsetAt,
  WINDOW_DAYS,
} from "./usage.ts";

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

const claudeUsage = {
  input_tokens: 2,
  output_tokens: 274,
  cache_read_input_tokens: 11586,
  cache_creation_input_tokens: 33850,
};
const claudeEntry = (uuid: string, messageId: string, content: string, timestamp: string) => ({
  type: "assistant",
  uuid,
  timestamp,
  message: {
    id: messageId,
    model: "claude-opus-5-5",
    role: "assistant",
    content: [{ type: content }],
    usage: claudeUsage,
  },
});

const piAssistant = (id: string, responseId: string | undefined, timestamp: number) => ({
  type: "message",
  id,
  timestamp: "2026-10-14T05:37:10.444Z",
  message: {
    role: "assistant",
    provider: "pi-sub-anthropic",
    model: "claude-opus-5-5",
    ...(responseId ? { responseId } : {}),
    timestamp,
    usage: { input: 11658, output: 442, cacheRead: 26851, cacheWrite: 0, totalTokens: 38951 },
  },
});

const codexContext = (ordinal: number, model: string) => ({
  timestamp: "2026-10-12T22:25:50.596Z",
  ordinal,
  type: "turn_context",
  payload: { model, effort: "high" },
});
const codexTokens = (ordinal: number, total: number, input = 29661) => ({
  timestamp: "2026-10-12T22:26:02.372Z",
  ordinal,
  type: "event_msg",
  payload: {
    type: "token_count",
    info: {
      total_token_usage: { total_tokens: total },
      last_token_usage: {
        input_tokens: input,
        cached_input_tokens: 22272,
        cache_write_input_tokens: 0,
        output_tokens: 62,
        reasoning_output_tokens: 26,
      },
    },
  },
});

test("Claude Code usage is normalized and keyed by API message, so content blocks count once", () => {
  const traces = transcript("claude-code", [
    claudeEntry("a", "msg_1", "thinking", "2026-10-11T18:16:16.845Z"),
    claudeEntry("b", "msg_1", "tool_use", "2026-10-11T18:16:17.630Z"),
    { type: "user", uuid: "c", message: { role: "user", content: "hi" } },
  ]);
  const usage = usageOf(traces);
  expect(usage).toHaveLength(2);
  expect(new Set(usage.map((record) => record.key))).toEqual(new Set(["claude-code:msg_1"]));
  expect(usage[0]).toMatchObject({
    model: "claude-opus-5-5",
    inputTokens: 2,
    outputTokens: 274,
    cacheReadTokens: 11586,
    cacheWriteTokens: 33850,
    occurredAt: "2026-10-11T18:16:16.845Z",
  });
});

test("pi usage is keyed by provider response, falling back to the request timestamp", () => {
  const [withResponse, withTimestamp] = usageOf(
    transcript("pi", [piAssistant("p1", "resp_1", 1), piAssistant("p2", undefined, 1791956223270)]),
  );
  expect(withResponse?.key).toBe("pi:pi-sub-anthropic:resp_1");
  expect(withTimestamp?.key).toBe("pi:pi-sub-anthropic:1791956223270");
  expect(withResponse).toMatchObject({
    inputTokens: 11658,
    outputTokens: 442,
    cacheReadTokens: 26851,
  });
});

test("omp usage is read like pi's, keyed under omp", () => {
  const [usage] = usageOf(transcript("omp", [piAssistant("o1", "resp_1", 1)]));
  expect(usage).toMatchObject({
    key: "omp:pi-sub-anthropic:resp_1",
    source: "omp",
    model: "claude-opus-5-5",
    inputTokens: 11658,
    cacheReadTokens: 26851,
  });
});

test("Codex usage takes the turn's model, excludes cached input, and dedups repeated counts", () => {
  const usage = usageOf(
    transcript("codex", [
      codexTokens(1, 100),
      codexContext(2, "gpt-6-luna"),
      codexTokens(3, 52612),
      codexTokens(4, 52612),
      codexContext(5, "gpt-5.5"),
      codexTokens(6, 82415),
      { type: "event_msg", ordinal: 7, payload: { type: "token_count", info: null } },
    ]),
  );
  expect(usage.map((record) => [record.key, record.model])).toEqual([
    ["codex:session-1:total=100", undefined],
    ["codex:session-1:total=52612", "gpt-6-luna"],
    ["codex:session-1:total=52612", "gpt-6-luna"],
    ["codex:session-1:total=82415", "gpt-5.5"],
  ]);
  expect(usage[1]).toMatchObject({
    inputTokens: 29661 - 22272,
    cacheReadTokens: 22272,
    outputTokens: 62,
  });
});

test("entries without usage, zero-token responses, and hook events yield nothing", () => {
  const [synthetic] = transcript("claude-code", [
    {
      ...claudeEntry("s", "msg_s", "text", "2026-10-11T18:16:16.845Z"),
      message: { id: "msg_s", model: "<synthetic>", usage: { input_tokens: 0, output_tokens: 0 } },
    },
  ]);
  expect(synthetic && traceUsage(synthetic)).toBeUndefined();
  const hook: Trace = {
    owner,
    id: "hook-1" as Trace["id"],
    source: "claude-code",
    sessionId: "s" as Trace["sessionId"],
    event: "assistant" as Trace["event"],
    occurredAt: "2026-10-11T18:16:16.845Z",
    summary: "assistant",
    raw: { message: "not an object" },
  };
  expect(traceUsage(hook)).toBeUndefined();
});

test("the stats window spans 53 weeks of local days ending today", () => {
  const now = Date.parse("2026-10-14T02:00:00Z");
  const eastern = statsWindow(now, -240);
  expect(eastern.to).toBe("2026-10-13");
  expect(eastern.since).toBe(`${eastern.from}T04:00:00.000Z`);
  const days = (Date.parse(eastern.to) - Date.parse(eastern.from)) / 86_400_000 + 1;
  expect(days).toBe(WINDOW_DAYS);
  expect(statsWindow(now, 0).to).toBe("2026-10-14");
});

test("aggregation groups by local day and hour, model, and source", () => {
  const records = usageOf([
    ...transcript("claude-code", [
      claudeEntry("a", "msg_1", "text", "2026-10-11T03:30:00Z"),
      claudeEntry("b", "msg_2", "text", "2026-10-11T18:00:00Z"),
    ]),
    ...transcript("codex", [codexContext(1, "gpt-5.5"), codexTokens(2, 10)], "session-2"),
  ]);
  const result = aggregate(records, -240);
  expect(result.days.map((day) => [day.day, day.responses, day.sessions])).toEqual([
    ["2026-10-10", 1, 1],
    ["2026-10-11", 1, 1],
    ["2026-10-12", 1, 1],
  ]);
  expect(result.hours[23]).toBe(1);
  expect(result.hours[14]).toBe(1);
  expect(result.hours[18]).toBe(1);
  expect(result.sessions).toBe(2);
  expect(result.models.map((model) => [model.source, model.model, model.responses])).toEqual([
    ["claude-code", "claude-opus-5-5", 2],
    ["codex", "gpt-5.5", 1],
  ]);
  expect(result.sources.map((source) => [source.source, source.sessions])).toEqual([
    ["claude-code", 1],
    ["codex", 1],
  ]);
});

const memory = (traces: Array<Trace>) =>
  Layer.mergeAll(
    UsageStore.memoryWith(() => traces),
    TraceStore.memory,
    Layer.succeed(Identity, { owner: Effect.succeed(owner) }),
  );

test("the sweep records each response once, inherits Codex models across runs, and resumes", async () => {
  const traces: Array<Trace> = transcript("codex", [
    codexContext(1, "gpt-5.5"),
    codexTokens(2, 10),
  ]);
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const first = yield* recordPendingUsage();
      // The next upload starts mid-turn, after the turn_context.
      traces.push(
        ...transcript("codex", [codexTokens(3, 20), codexTokens(3, 20)]).map((trace, index) => ({
          ...trace,
          id: `${trace.id}-${index}` as Trace["id"],
        })),
      );
      const second = yield* recordPendingUsage();
      const idle = yield* recordPendingUsage();
      const store = yield* UsageStore;
      return { first, second, idle, stats: yield* store.aggregate(owner, "2026-01-01", 0) };
    }).pipe(Effect.provide(memory(traces))),
  );
  expect(result.first).toEqual({ scanned: 2, projected: 1 });
  expect(result.second).toEqual({ scanned: 2, projected: 2 });
  expect(result.idle).toEqual({ scanned: 0, projected: 0 });
  expect(result.stats.models).toEqual([
    expect.objectContaining({ source: "codex", model: "gpt-5.5", responses: 2 }),
  ]);
});

test("the sweep reads at most a batch per run", async () => {
  const traces = transcript(
    "claude-code",
    Array.from({ length: USAGE_BATCH_SIZE + 3 }, (_, index) =>
      claudeEntry(`u${index}`, `msg_${index}`, "text", "2026-10-11T18:00:00Z"),
    ),
  );
  const runs = await Effect.runPromise(
    Effect.all([recordPendingUsage(), recordPendingUsage()]).pipe(Effect.provide(memory(traces))),
  );
  expect(runs.map((run) => run.projected)).toEqual([USAGE_BATCH_SIZE, 3]);
});

const showcase = Layer.succeed(Showcase, {
  owner,
  timeZone: TimeZone.make("America/New_York"),
});

test("time zones decode only when known, and offsets follow daylight saving", () => {
  expect(() => TimeZone.make("Mars/Olympus_Mons")).toThrow();
  const zone = TimeZone.make("America/New_York");
  expect(utcOffsetAt(zone, Date.parse("2026-07-01T12:00:00Z"))).toBe(-240);
  expect(utcOffsetAt(zone, Date.parse("2026-01-01T12:00:00Z"))).toBe(-300);
  expect(utcOffsetAt(TimeZone.make("Asia/Kolkata"), 0)).toBe(330);
  expect(utcOffsetAt(TimeZone.make("UTC"), 0)).toBe(0);
});

test("public stats need no identity, use the owner's zone, and are served from a snapshot", async () => {
  const traces: Array<Trace> = [];
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-10-14T02:00:00Z"));
      traces.push(
        ...transcript("claude-code", [claudeEntry("a", "m1", "text", "2026-10-13T20:00:00Z")]),
      );
      // The first request computes and stores the snapshot.
      const first = yield* publicUsageStats();
      yield* recordPendingUsage();
      // Later requests serve it unchanged, even with new usage recorded.
      const cached = yield* publicUsageStats();
      // The refresh waits until the snapshot is old enough...
      const early = yield* refreshUsageStats();
      yield* TestClock.adjust(SNAPSHOT_REFRESH_MS);
      const due = yield* refreshUsageStats();
      const idle = yield* refreshUsageStats();
      const fresh = yield* publicUsageStats();
      // ...but a new local day refreshes right away.
      yield* TestClock.setTime(Date.parse("2026-10-14T04:01:00Z"));
      const nextDay = yield* refreshUsageStats();
      return { first, cached, early, due, idle, fresh, nextDay, after: yield* publicUsageStats() };
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          UsageStore.memoryWith(() => traces),
          TraceStore.memory,
          showcase,
          TestClock.layer(),
        ),
      ),
    ),
  );
  // 02:00 UTC is still Oct 13 in New York.
  expect(result.first.stats).toMatchObject({
    to: "2026-10-13",
    days: [],
  });
  expect(result.first.stats).not.toHaveProperty("tools");
  expect(result.cached).toEqual(result.first);
  expect([result.early, result.due, result.idle]).toEqual([false, true, false]);
  expect(result.fresh.stats.days.map((day) => [day.day, day.responses])).toEqual([
    ["2026-10-13", 1],
  ]);
  expect(result.nextDay).toBe(true);
  expect(result.after.stats.to).toBe("2026-10-14");
});

test("a snapshot that no longer decodes is recomputed, and an older write can't replace a newer one", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* UsageStore;
      yield* store.writeSnapshot(owner, {
        stats: { legacy: true } as never,
        generatedAt: "2026-10-14T00:00:00.000Z",
        cursor: 0,
      });
      yield* TestClock.setTime(Date.parse("2026-10-14T12:00:00Z"));
      const recomputed = yield* publicUsageStats();
      yield* store.writeSnapshot(owner, {
        ...(yield* Schema.encodeEffect(StatsSnapshot)(recomputed)),
        stats: { legacy: "stale" } as never,
        generatedAt: "2026-10-14T11:00:00.000Z",
      });
      return { recomputed, served: yield* publicUsageStats() };
    }).pipe(
      Effect.provide(
        Layer.mergeAll(UsageStore.memory, TraceStore.memory, showcase, TestClock.layer()),
      ),
    ),
  );
  expect(result.recomputed.generatedAt).toBe("2026-10-14T12:00:00.000Z");
  expect(result.served).toEqual(result.recomputed);
});
