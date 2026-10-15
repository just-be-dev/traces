import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import {
  EventId,
  Identity,
  INDEX_BATCH_SIZE,
  indexPendingTraces,
  MAX_CONTENT_RESULTS,
  MAX_SEARCH_RESULTS,
  normalize,
  rankTools,
  Owner,
  SearchQuery,
  searchText,
  searchTraceContents,
  searchTraces,
  submitTrace,
  Submission,
  type Trace,
  TraceIndex,
  TraceIndexError,
  TraceStore,
  Unauthenticated,
} from "./traces.ts";

const owner = Owner.make("owner");
const submission = (id: string, overrides: Record<string, unknown> = {}) =>
  Schema.decodeSync(Submission)({
    id,
    source: "codex",
    sessionId: "session-1",
    event: "PostToolUse",
    occurredAt: "2026-10-09T12:00:00Z",
    raw: { tool_name: "Bash" },
    ...overrides,
  });
const query = (text: string) => Schema.decodeSync(SearchQuery)(text);

const withStore = <A, E>(program: Effect.Effect<A, E, TraceStore>) =>
  Effect.runPromise(program.pipe(Effect.provide(TraceStore.memory)));

test("memory store scopes by owner, matches like D1, and returns newest first up to the cap", async () => {
  const results = await withStore(
    Effect.gen(function* () {
      const store = yield* TraceStore;
      yield* store.insert(
        normalize(owner, submission("a", { occurredAt: "2026-10-09T10:00:00Z" })),
      );
      yield* store.insert(
        normalize(owner, submission("b", { occurredAt: "2026-10-09T11:00:00Z" })),
      );
      yield* store.insert(normalize(Owner.make("someone-else"), submission("c")));
      const first = yield* store.insert(
        normalize(owner, submission("a", { raw: { tool_name: "Other" } })),
      );
      return {
        first,
        caseInsensitive: yield* store.search(owner, query("bash")),
        session: yield* store.search(owner, query("session-1")),
        sessionIsExact: yield* store.search(owner, query("session")),
      };
    }),
  );
  expect(results.first).toBe(false);
  expect(results.caseInsensitive.map((trace) => String(trace.id))).toEqual(["b", "a"]);
  expect(results.caseInsensitive[1]?.summary).toBe("Bash");
  expect(results.session.map((trace) => String(trace.id))).toEqual(["b", "a"]);
  expect(results.sessionIsExact).toEqual([]);

  const capped = await withStore(
    Effect.gen(function* () {
      const store = yield* TraceStore;
      for (let index = 0; index < MAX_SEARCH_RESULTS + 5; index++)
        yield* store.insert(normalize(owner, submission(`event-${index}`)));
      return yield* store.search(owner, query("Bash"));
    }),
  );
  expect(capped).toHaveLength(MAX_SEARCH_RESULTS);
});

test("operations authorize before reading the body or touching storage", async () => {
  const anonymous = Layer.mergeAll(
    Layer.succeed(Identity, { owner: Effect.fail(new Unauthenticated()) }),
    Layer.succeed(TraceStore, {
      insert: () => Effect.die("unexpected write"),
      insertMany: () => Effect.die("unexpected write"),
      search: () => Effect.die("unexpected read"),
      get: () => Effect.die("unexpected read"),
      unindexed: () => Effect.die("unexpected read"),
      markIndexed: () => Effect.die("unexpected write"),
      tools: () => Effect.die("unexpected read"),
    }),
    Layer.succeed(TraceIndex, {
      index: () => Effect.die("unexpected index"),
      search: () => Effect.die("unexpected search"),
    }),
  );
  const submitted = await Effect.runPromise(
    submitTrace(Effect.die("body read before authorization")).pipe(
      Effect.flip,
      Effect.provide(anonymous),
    ),
  );
  expect(submitted._tag).toBe("Unauthenticated");
  const searched = await Effect.runPromise(
    searchTraces("").pipe(Effect.flip, Effect.provide(anonymous)),
  );
  expect(searched._tag).toBe("Unauthenticated");
  const contents = await Effect.runPromise(
    searchTraceContents("anything").pipe(Effect.flip, Effect.provide(anonymous)),
  );
  expect(contents._tag).toBe("Unauthenticated");
});

test("submission rejects oversized payloads and keeps the raw payload unchanged", async () => {
  const signedIn = Layer.mergeAll(
    Layer.succeed(Identity, { owner: Effect.succeed(owner) }),
    TraceStore.memory,
    TraceIndex.memory,
  );
  const raw = { tool_name: "Read", tool_input: { file_path: "README.md" }, extra: [1, null] };
  const [inserted, found, tooLarge] = await Effect.runPromise(
    Effect.all([
      submitTrace(Effect.succeed({ ...submission("one"), raw })),
      searchTraces("Read"),
      submitTrace(Effect.succeed({ ...submission("two"), raw: "x".repeat(64_001) })).pipe(
        Effect.flip,
      ),
    ]).pipe(Effect.provide(signedIn)),
  );
  expect(inserted).toBe(true);
  expect(found.map((trace) => trace.raw)).toEqual([raw]);
  expect(tooLarge._tag).toBe("TraceEventTooLarge");
});

const trace = (id: string, raw: unknown, overrides: Record<string, unknown> = {}): Trace =>
  normalize(owner, submission(id, { raw, ...overrides }));

test("search text unescapes every scalar in the payload under its path", () => {
  const text = searchText(
    trace("one", {
      tool_name: "Edit",
      tool_input: { file_path: "src/a.ts", edits: [{ old: 'say "hi"\nbye' }, 3, true, null] },
    }),
  );
  expect(text.split("\n")).toEqual([
    "source: codex",
    "session: session-1",
    "event: PostToolUse",
    "tool: Edit",
    "tool_name: Edit",
    "tool_input.file_path: src/a.ts",
    'tool_input.edits[0].old: say "hi"',
    "bye",
    "tool_input.edits[1]: 3",
    "tool_input.edits[2]: true",
  ]);
  expect(searchText(trace("two", "plain prompt")).split("\n").at(-1)).toBe("raw: plain prompt");
});

// Wraps the memory index so tests can make uploads fail and count them.
const flakyIndex = () => {
  const state = { failing: new Set<string>(), uploads: [] as Array<string> };
  const layer = Layer.effect(
    TraceIndex,
    Effect.gen(function* () {
      const memory = yield* TraceIndex;
      return {
        search: memory.search,
        index: (trace: Trace) =>
          state.failing.has(trace.id) || state.failing.has("*")
            ? Effect.fail(
                new TraceIndexError({ operation: "index", cause: new Error("AI Search 503") }),
              )
            : Effect.sync(() => state.uploads.push(trace.id)).pipe(
                Effect.andThen(memory.index(trace)),
              ),
      };
    }),
  ).pipe(Layer.provide(TraceIndex.memory));
  return { state, layer };
};

const captureLogs = () => {
  const logs: Array<unknown> = [];
  const rendered: Array<string> = [];
  const layer = Logger.layer([
    Logger.make((options) => {
      // The first message part is the text; the rest is the logged cause.
      const [text, ...causes] = options.message as ReadonlyArray<unknown>;
      logs.push([text, options.fiber.getRef(References.CurrentLogAnnotations)]);
      rendered.push(JSON.stringify(causes.map(String)));
    }),
  ]);
  return { logs, rendered, layer };
};

const signedInAs = (who: Owner) => Layer.succeed(Identity, { owner: Effect.succeed(who) });
const ids = (traces: ReadonlyArray<Trace>) => traces.map((found) => String(found.id));

test("submission indexes new traces so content search finds payload text, scoped to the owner", async () => {
  const index = flakyIndex();
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const submit = (id: string, raw: unknown, who = owner) =>
        submitTrace(Effect.succeed({ ...submission(id), raw })).pipe(
          Effect.provide(signedInAs(who)),
        );
      yield* submit("read", { tool_name: "Read", tool_input: { file_path: "src/Router.ts" } });
      yield* submit("grep", {
        tool_name: "Grep",
        tool_input: { pattern: "router" },
        tool_response: "src/Router.ts: export const router = ...",
      });
      yield* submit("theirs", { tool_input: { file_path: "src/Router.ts" } }, Owner.make("other"));
      // The first payload wins: a repeat is neither stored nor uploaded again.
      yield* submit("read", { tool_name: "Write", tool_input: { secret: "replacement" } });
      const search = (text: string) =>
        searchTraceContents(text).pipe(Effect.provide(signedInAs(owner)));
      return {
        substring: yield* search("ROUTER"),
        allTerms: yield* search("router pattern"),
        replaced: yield* search("replacement"),
        pending: yield* (yield* TraceStore).unindexed(10, 1_000_000),
        invalid: yield* searchTraceContents("x".repeat(201)).pipe(
          Effect.flip,
          Effect.provide(signedInAs(owner)),
        ),
      };
    }).pipe(Effect.provide(Layer.mergeAll(TraceStore.memory, index.layer))),
  );
  // "grep" mentions the term three times and "read" once, so "grep" ranks first.
  expect(ids(result.substring)).toEqual(["grep", "read"]);
  expect(ids(result.allTerms)).toEqual(["grep"]);
  expect(result.replaced).toEqual([]);
  expect(result.pending).toEqual([]);
  expect(index.state.uploads).toEqual(["read", "grep", "theirs"]);
  expect(result.invalid._tag).toBe("InvalidSearchQuery");
});

test("an index outage never fails a stored submission, and the sweep catches up", async () => {
  const index = flakyIndex();
  const logs = captureLogs();
  index.state.failing.add("*");
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const inserted = yield* submitTrace(
        Effect.succeed({ ...submission("event-1"), raw: { prompt: "private words" } }),
      );
      const whileDown = yield* searchTraceContents("private");
      const failedSweep = yield* indexPendingTraces();
      index.state.failing.clear();
      const sweep = yield* indexPendingTraces();
      const repeat = yield* indexPendingTraces();
      return {
        inserted,
        whileDown,
        failedSweep,
        sweep,
        repeat,
        found: yield* searchTraceContents("private"),
      };
    }).pipe(
      Effect.provide(Layer.mergeAll(TraceStore.memory, index.layer, signedInAs(owner), logs.layer)),
    ),
  );
  expect(result.inserted).toBe(true);
  expect(result.whileDown).toEqual([]);
  expect(result.failedSweep).toEqual({ indexed: 0, failed: 1 });
  expect(result.sweep).toEqual({ indexed: 1, failed: 0 });
  expect(result.repeat).toEqual({ indexed: 0, failed: 0 });
  expect(ids(result.found)).toEqual(["event-1"]);
  expect(logs.logs).toEqual([
    ["Trace indexing deferred to the scheduled sweep", { "traces.operation": "index" }],
    ["Trace indexing deferred to the scheduled sweep", { "traces.operation": "index" }],
  ]);
  const logged = JSON.stringify([logs.logs, logs.rendered]);
  for (const secret of ["private", "event-1", "session-1"]) expect(logged).not.toContain(secret);
});

test("the sweep backfills newest first in batches and one failure doesn't stop the rest", async () => {
  const index = flakyIndex();
  const logs = captureLogs();
  index.state.failing.add("event-003");
  const total = INDEX_BATCH_SIZE + 5;
  const runs = await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* TraceStore;
      // Stored before content search existed: in D1 but never indexed.
      for (let n = 0; n < total; n++) {
        const id = `event-${String(n).padStart(3, "0")}`;
        const time = new Date(Date.UTC(2026, 9, 9, 12, 0, n)).toISOString();
        yield* store.insert(trace(id, { n }, { occurredAt: time }));
      }
      const first = yield* indexPendingTraces();
      const second = yield* indexPendingTraces();
      return { first, second, left: ids(yield* store.unindexed(10, 1_000_000)) };
    }).pipe(Effect.provide(Layer.mergeAll(TraceStore.memory, index.layer, logs.layer))),
  );
  expect(runs.first).toEqual({ indexed: INDEX_BATCH_SIZE, failed: 0 });
  expect(index.state.uploads.slice(0, 2)).toEqual([`event-${total - 1}`, `event-${total - 2}`]);
  expect(runs.second).toEqual({ indexed: 4, failed: 1 });
  expect(runs.left).toEqual(["event-003"]);
  expect(logs.logs).toHaveLength(1);
  expect(JSON.stringify([logs.logs, logs.rendered])).not.toContain("event-003");
});

test("content search reads hits back through the owner's store scope, in rank order", async () => {
  const ranked = [EventId.make("b"), EventId.make("gone"), EventId.make("a"), EventId.make("c")];
  const found = await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* TraceStore;
      yield* store.insert(trace("a", {}));
      yield* store.insert(trace("b", {}));
      // A hit for another owner's event must not leak, even if the index returned it.
      yield* store.insert(normalize(Owner.make("other"), submission("c")));
      return yield* searchTraceContents("anything");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          TraceStore.memory,
          signedInAs(owner),
          Layer.succeed(TraceIndex, {
            index: () => Effect.void,
            search: () => Effect.succeed(ranked),
          }),
        ),
      ),
    ),
  );
  expect(ids(found)).toEqual(["b", "a"]);
});

test("memory content index requires every term and caps results", async () => {
  const found = await Effect.runPromise(
    Effect.gen(function* () {
      const index = yield* TraceIndex;
      for (let n = 0; n < MAX_CONTENT_RESULTS + 3; n++)
        yield* index.index(trace(`event-${n}`, { text: n % 2 ? "alpha beta" : "alpha" }));
      return {
        alpha: yield* index.search(owner, query("ALPHA")),
        both: yield* index.search(owner, query("beta  alpha")),
        missing: yield* index.search(owner, query("alpha gamma")),
      };
    }).pipe(Effect.provide(TraceIndex.memory)),
  );
  expect(found.alpha).toHaveLength(MAX_CONTENT_RESULTS);
  expect(found.both).toHaveLength(11);
  expect(found.missing).toEqual([]);
});

test("tool ranking merges spellings across harnesses under the most frequent one", () => {
  expect(
    rankTools(
      [
        { summary: "Bash", count: 5 },
        { summary: "bash, Read", count: 2 },
        { summary: "read", count: 1 },
      ],
      8,
    ),
  ).toEqual([
    { tool: "Bash", calls: 7 },
    { tool: "Read", calls: 3 },
  ]);
});
