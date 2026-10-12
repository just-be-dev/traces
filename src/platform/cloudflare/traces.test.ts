import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import { Identity, Owner, SearchQuery, Trace, TraceStore } from "../../traces.ts";
import { type D1Statements, identity, storage } from "./traces.ts";

// Stands in for the native D1 binding: every statement resolves or rejects as given.
const client = (outcome: { rows?: Array<unknown>; error?: Error }) => {
  const settle = <A>(value: A) =>
    outcome.error ? Promise.reject(outcome.error) : Promise.resolve(value);
  const statement = {
    all: () => settle({ results: outcome.rows ?? [] }),
    run: () => settle({ meta: { changes: 1 } }),
  };
  const d1: D1Statements = { prepare: () => ({ bind: () => statement }) };
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

test("D1 rejections become typed TraceStoreErrors for both operations", async () => {
  const layer = storage(client({ error: new Error("D1_ERROR: database is locked") }));
  const [insert, search] = await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* TraceStore;
      return yield* Effect.all([
        store.insert(trace).pipe(Effect.flip),
        store.search(owner, query).pipe(Effect.flip),
      ]);
    }).pipe(Effect.provide(layer)),
  );
  expect([insert._tag, insert.operation]).toEqual(["TraceStoreError", "insert"]);
  expect([search._tag, search.operation]).toEqual(["TraceStoreError", "search"]);
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
