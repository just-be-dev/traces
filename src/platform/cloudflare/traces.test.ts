import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import { EventId, Identity, Owner, SearchQuery, Trace, TraceStore } from "../../traces.ts";
import { sqliteD1 } from "./d1.testing.ts";
import { type D1Statements, identity, storage } from "./traces.ts";

// Stands in for the native D1 binding: every statement resolves or rejects as given,
// and each prepared query is recorded with its bound values.
const client = (
  outcome: { rows?: Array<unknown>; error?: Error },
  queries: Array<[string, Array<unknown>]> = [],
) => {
  const settle = <A>(value: A) =>
    outcome.error ? Promise.reject(outcome.error) : Promise.resolve(value);
  const d1: D1Statements = {
    prepare: (sql) => ({
      bind: (...values) => {
        queries.push([sql, values]);
        return {
          all: () => settle({ results: outcome.rows ?? [] }),
          run: () => settle({ meta: { changes: 1 } }),
        };
      },
    }),
    batch: (statements) => settle(statements.map(() => ({ meta: { changes: 1 } }))),
  };
  return Effect.succeed(d1);
};

const row = (id: string, raw: string) => ({
  owner: "owner",
  id,
  source: "claude-code",
  session_id: "session-1",
  event: "PostToolUse",
  occurred_at: "2026-10-09T12:00:00Z",
  summary: "Read",
  raw,
});

const owner = Owner.make("owner");
const query = Schema.decodeSync(SearchQuery)("Read");
const trace = Schema.decodeSync(Trace)({
  owner,
  id: "event-1",
  source: "codex",
  sessionId: "session-1",
  event: "Stop",
  occurredAt: "2026-10-09T12:00:00Z",
  raw: {},
  summary: "Stop",
});

test("search skips rows that no longer decode and logs only their event ID", async () => {
  const logs: Array<unknown> = [];
  const capture = Logger.make((options) => {
    logs.push([options.message, options.fiber.getRef(References.CurrentLogAnnotations)]);
  });
  const rows = [
    row("good", JSON.stringify({ tool_name: "Read" })),
    row("broken-json", "{secret"),
    { ...row("unknown-source", "{}"), source: "cursor" },
  ];
  const traces = await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* TraceStore;
      return yield* store.search(owner, query);
    }).pipe(Effect.provide(Layer.mergeAll(storage(client({ rows })), Logger.layer([capture])))),
  );
  expect(traces.map((trace) => [trace.id, trace.sessionId, trace.raw])).toEqual([
    ["good", "session-1", { tool_name: "Read" }],
  ] as never);
  expect(logs).toEqual([
    [["Skipped stored trace that no longer decodes"], { "traces.event_id": "broken-json" }],
    [["Skipped stored trace that no longer decodes"], { "traces.event_id": "unknown-source" }],
  ]);
  expect(JSON.stringify(logs)).not.toContain("secret");
});

test("D1 rejections become typed TraceStoreErrors for every operation", async () => {
  const layer = storage(client({ error: new Error("D1_ERROR: database is locked") }));
  const errors = await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* TraceStore;
      return yield* Effect.all([
        store.insert(trace).pipe(Effect.flip),
        store.search(owner, query).pipe(Effect.flip),
        store.get(owner, [trace.id]).pipe(Effect.flip),
        store.unindexed(5, 1_000_000).pipe(Effect.flip),
        store.markIndexed(owner, trace.id).pipe(Effect.flip),
      ]);
    }).pipe(Effect.provide(layer)),
  );
  expect(errors.map((error) => [error._tag, error.operation])).toEqual([
    ["TraceStoreError", "insert"],
    ["TraceStoreError", "search"],
    ["TraceStoreError", "get"],
    ["TraceStoreError", "unindexed"],
    ["TraceStoreError", "markIndexed"],
  ]);
});

test("get is owner-scoped, restores the requested order, and skips the query for no IDs", async () => {
  const queries: Array<[string, Array<unknown>]> = [];
  const rows = [row("a", "{}"), row("b", "{}")];
  const [found, none] = await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* TraceStore;
      return yield* Effect.all([
        store.get(
          owner,
          ["b", "missing", "a"].map((id) => EventId.make(id)),
        ),
        store.get(owner, []),
      ]);
    }).pipe(Effect.provide(storage(client({ rows }, queries)))),
  );
  expect(found.map((trace) => String(trace.id))).toEqual(["b", "a"]);
  expect(none).toEqual([]);
  expect(queries).toEqual([
    [
      "SELECT owner, id, source, session_id, event, occurred_at, summary, raw FROM events WHERE owner = ? AND id IN (?, ?, ?)",
      ["owner", "b", "missing", "a"],
    ],
  ]);
});

test("the sweep reads unindexed rows newest first and marks one owner's event", async () => {
  const queries: Array<[string, Array<unknown>]> = [];
  await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* TraceStore;
      yield* store.unindexed(25, 1_000_000);
      yield* store.markIndexed(owner, trace.id);
    }).pipe(Effect.provide(storage(client({ rows: [] }, queries)))),
  );
  expect(queries[0]?.[0]).toContain(
    "WHERE indexed_at IS NULL ORDER BY occurred_at DESC, id DESC LIMIT ?",
  );
  expect(queries[0]?.[1]).toEqual([25, 1_000_000]);
  expect(queries.slice(1)).toEqual([
    [
      "UPDATE events SET indexed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE owner = ? AND id = ?",
      ["owner", "event-1"],
    ],
  ]);
});

test("identity requires an Access context and maps every admitted request to the owner", async () => {
  const resolve = (access: { readonly aud: string } | undefined) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* Identity;
        return yield* Effect.result(service.owner);
      }).pipe(Effect.provide(identity(Effect.succeed(access)))),
    );
  const missing = await resolve(undefined);
  expect(missing._tag === "Failure" && missing.failure._tag).toBe("Unauthenticated");
  const admitted = await resolve({ aud: "local" });
  expect(admitted._tag === "Success" && String(admitted.success)).toBe("owner");
});

// D1 is SQLite, so the real migrations and adapter queries run against bun:sqlite.
// This checks SQL and migration syntax, not D1's network or consistency behavior.
test("migrations apply and every adapter query runs against SQLite", async () => {
  const { db, d1 } = await sqliteD1();
  const at = (id: string, time: string, who = owner) =>
    Schema.decodeSync(Trace)({ ...trace, owner: who, id, occurredAt: `2026-10-09T${time}Z` });
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* TraceStore;
      yield* store.insert(at("old", "10:00:00"));
      yield* store.insert(at("new", "11:00:00"));
      yield* store.insert(at("theirs", "12:00:00", Owner.make("other")));
      const duplicate = yield* store.insert(at("old", "13:00:00"));
      // Existing, new, and repeated-in-batch IDs: only the first "batch" row is new.
      const batched = yield* store.insertMany([
        at("old", "14:00:00"),
        at("batch", "09:00:00"),
        at("batch", "09:30:00"),
      ]);
      const before = yield* store.unindexed(10, 1_000_000);
      yield* store.markIndexed(owner, EventId.make("new"));
      yield* store.markIndexed(owner, EventId.make("theirs"));
      return {
        duplicate,
        batched,
        before: before.map((found) => `${found.owner}/${found.id}`),
        after: (yield* store.unindexed(10, 1_000_000)).map((found) => `${found.owner}/${found.id}`),
        got: (yield* store.get(
          owner,
          ["theirs", "old", "new"].map((id) => EventId.make(id)),
        )).map((found) => String(found.id)),
      };
    }).pipe(Effect.provide(storage(Effect.succeed(d1)))),
  );
  expect(result).toEqual({
    duplicate: false,
    batched: 1,
    before: ["other/theirs", "owner/new", "owner/old", "owner/batch"],
    // Marking "theirs" as this owner touched nothing: the update is owner-scoped.
    after: ["other/theirs", "owner/old", "owner/batch"],
    got: ["old", "new"],
  });
  const plan = db
    .query(
      "EXPLAIN QUERY PLAN SELECT id FROM events WHERE indexed_at IS NULL ORDER BY occurred_at DESC, id DESC LIMIT 25",
    )
    .all();
  expect(JSON.stringify(plan)).toContain("events_unindexed");
});

test("the sweep's read stops at the byte budget but always returns the newest row", async () => {
  const { d1 } = await sqliteD1();
  const big = (id: string, time: string, size: number) =>
    Schema.decodeSync(Trace)({
      ...trace,
      id,
      occurredAt: `2026-10-09T${time}Z`,
      raw: { text: "x".repeat(size) },
    });
  const read = await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* TraceStore;
      yield* store.insertMany([
        big("newest", "12:00:00", 600),
        big("middle", "11:00:00", 300),
        big("oldest", "10:00:00", 10),
      ]);
      const ids = (traces: ReadonlyArray<Trace>) => traces.map((found) => String(found.id));
      return {
        tight: ids(yield* store.unindexed(10, 100)),
        two: ids(yield* store.unindexed(10, 930)),
        all: ids(yield* store.unindexed(10, 10_000)),
        limited: ids(yield* store.unindexed(2, 10_000)),
      };
    }).pipe(Effect.provide(storage(Effect.succeed(d1)))),
  );
  expect(read).toEqual({
    tight: ["newest"],
    two: ["newest", "middle"],
    all: ["newest", "middle", "oldest"],
    limited: ["newest", "middle"],
  });
});
