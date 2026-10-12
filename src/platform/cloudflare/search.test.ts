import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  EventId,
  MAX_CONTENT_RESULTS,
  Owner,
  SearchQuery,
  searchText,
  Trace,
  TraceIndex,
} from "../../traces.ts";
import { contentIndex, documentName, type SearchInstanceBinding } from "./search.ts";

const owner = Owner.make("owner");
const trace = (id: string, who = owner) =>
  Schema.decodeSync(Trace)({
    owner: who,
    id,
    source: "claude-code",
    sessionId: "session-1",
    event: "PostToolUse",
    occurredAt: "2026-10-09T12:00:00Z",
    raw: { tool_name: "Bash", tool_input: { command: "grep -rn needle src" } },
    summary: "Bash",
  });

// Stands in for the native `ai_search` binding and records every call.
const binding = (outcome: { response?: unknown; error?: Error }) => {
  const calls: Array<unknown> = [];
  const settle = (value: unknown) =>
    outcome.error ? Promise.reject(outcome.error) : Promise.resolve(value);
  const search: SearchInstanceBinding = {
    search: (params) => {
      calls.push(["search", params]);
      return settle(outcome.response);
    },
    items: {
      upload: (name, content, options) => {
        calls.push(["upload", name, content, options]);
        return settle({ id: "item", key: name });
      },
    },
  };
  return { calls, layer: contentIndex(Effect.succeed(search)) };
};

const run = <A, E>(program: Effect.Effect<A, E, TraceIndex>, layer: ReturnType<typeof binding>) =>
  Effect.runPromise(program.pipe(Effect.provide(layer.layer)));

test("documents are named by a digest of owner and event, so re-uploads upsert", async () => {
  const names = await Effect.runPromise(
    Effect.all([
      documentName(owner, EventId.make("event-1")),
      documentName(owner, EventId.make("event-1")),
      documentName(Owner.make("other"), EventId.make("event-1")),
      documentName(owner, EventId.make("x".repeat(5_000))),
    ]),
  );
  expect(names[0]).toMatch(/^traces\/[0-9a-f]{64}\.txt$/);
  expect(names[1]).toBe(names[0]);
  expect(names[2]).not.toBe(names[0]);
  expect(names[3]?.length).toBeLessThanOrEqual(128);
});

test("index uploads the plain-text projection with owner and event metadata", async () => {
  const search = binding({});
  const indexed = trace("event-1");
  await run(
    Effect.gen(function* () {
      const index = yield* TraceIndex;
      yield* index.index(indexed);
    }),
    search,
  );
  const name = await Effect.runPromise(documentName(owner, indexed.id));
  expect(search.calls).toEqual([
    ["upload", name, searchText(indexed), { metadata: { owner: "owner", event_id: "event-1" } }],
  ]);
});

test("search filters by owner, keeps keyword hits, and ranks deduplicated event IDs", async () => {
  const chunk = (eventId: unknown) => ({
    id: "chunk",
    type: "text",
    score: 0.5,
    text: "",
    item: { key: "traces/x.txt", metadata: { owner: "owner", event_id: eventId } },
  });
  const response = {
    search_query: "needle",
    chunks: [
      chunk("b"),
      chunk("a"),
      chunk("b"),
      chunk(""),
      chunk(42),
      { ...chunk("x"), item: { key: "legacy.txt" } },
      ...Array.from({ length: MAX_CONTENT_RESULTS + 5 }, (_, n) => chunk(`more-${n}`)),
    ],
  };
  const search = binding({ response });
  const query = Schema.decodeSync(SearchQuery)("grep needle");
  const ids = await run(
    Effect.gen(function* () {
      const index = yield* TraceIndex;
      return yield* index.search(owner, query);
    }),
    search,
  );
  expect(ids.slice(0, 3)).toEqual(["b", "a", "more-0"] as never);
  expect(ids).toHaveLength(MAX_CONTENT_RESULTS);
  expect(search.calls).toEqual([
    [
      "search",
      {
        query: "grep needle",
        ai_search_options: {
          retrieval: {
            retrieval_type: "keyword",
            keyword_match_mode: "and",
            match_threshold: 0,
            max_num_results: 50,
            filters: { owner: "owner" },
            metadata_only: true,
            return_on_failure: false,
          },
        },
      },
    ],
  ]);
});

test("binding failures and unexpected responses become typed TraceIndexErrors", async () => {
  const failing = binding({ error: new Error("AiSearchInternalError") });
  const query = Schema.decodeSync(SearchQuery)("needle");
  const [index, search] = await run(
    Effect.gen(function* () {
      const service = yield* TraceIndex;
      return yield* Effect.all([
        service.index(trace("event-1")).pipe(Effect.flip),
        service.search(owner, query).pipe(Effect.flip),
      ]);
    }),
    failing,
  );
  expect([index._tag, index.operation]).toEqual(["TraceIndexError", "index"]);
  expect([search._tag, search.operation]).toEqual(["TraceIndexError", "search"]);

  const malformed = binding({ response: { chunks: [{ item: "secret-event-id" }] } });
  const shape = await run(
    Effect.gen(function* () {
      const service = yield* TraceIndex;
      return yield* service.search(owner, query).pipe(Effect.flip);
    }),
    malformed,
  );
  expect(shape.operation).toBe("search");
  // Parse messages would echo values; the cause must not carry them into logs.
  expect(String(shape.cause)).not.toContain("secret-event-id");
});
