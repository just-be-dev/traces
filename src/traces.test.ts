import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  Identity,
  MAX_SEARCH_RESULTS,
  normalize,
  Owner,
  SearchQuery,
  searchTraces,
  submitTrace,
  Submission,
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
      search: () => Effect.die("unexpected read"),
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
});

test("submission rejects oversized payloads and keeps the raw payload unchanged", async () => {
  const signedIn = Layer.mergeAll(
    Layer.succeed(Identity, { owner: Effect.succeed(owner) }),
    TraceStore.memory,
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
