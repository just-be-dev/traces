import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

const NonEmptyString = Schema.String.check(Schema.isMinLength(1));

export const Source = Schema.Union([
  Schema.Literal("pi"),
  Schema.Literal("claude-code"),
  Schema.Literal("codex"),
  Schema.Literal("amp"),
]);
export type Source = typeof Source.Type;

export const EventId = NonEmptyString.pipe(Schema.brand("EventId"));
export type EventId = typeof EventId.Type;

export const SessionId = NonEmptyString.pipe(Schema.brand("SessionId"));
export type SessionId = typeof SessionId.Type;

export const EventName = NonEmptyString.pipe(Schema.brand("EventName"));
export type EventName = typeof EventName.Type;

// The Access-admitted principal whose traces a request may read or write.
export const Owner = NonEmptyString.pipe(Schema.brand("Owner"));
export type Owner = typeof Owner.Type;

export const MAX_QUERY_LENGTH = 200;
export const SearchQuery = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_QUERY_LENGTH),
).pipe(Schema.brand("SearchQuery"));
export type SearchQuery = typeof SearchQuery.Type;

export const MAX_SEARCH_RESULTS = 100;
export const MAX_RAW_LENGTH = 64_000;

// Public wire format. Brands are type-level only, so the JSON shape is unchanged.
export const Submission = Schema.Struct({
  id: EventId,
  source: Source,
  sessionId: SessionId,
  event: EventName,
  occurredAt: Schema.String,
  raw: Schema.Json,
});
export type Submission = typeof Submission.Type;

export const Trace = Schema.Struct({
  ...Submission.fields,
  owner: Owner,
  summary: Schema.String,
});
export type Trace = typeof Trace.Type;

export class Unauthenticated extends Schema.TaggedError<Unauthenticated>()("Unauthenticated", {}) {}

// Carries no decode details: parse messages can echo submitted payload values.
export class InvalidTraceEvent extends Schema.TaggedError<InvalidTraceEvent>()(
  "InvalidTraceEvent",
  {},
) {}

export class TraceEventTooLarge extends Schema.TaggedError<TraceEventTooLarge>()(
  "TraceEventTooLarge",
  { length: Schema.Int, limit: Schema.Int },
) {}

export class InvalidSearchQuery extends Schema.TaggedError<InvalidSearchQuery>()(
  "InvalidSearchQuery",
  {},
) {}

export class TraceStoreError extends Schema.TaggedError<TraceStoreError>()("TraceStoreError", {
  operation: Schema.Literals(["insert", "search"]),
  cause: Schema.Defect(),
}) {}

export class TraceStore extends Context.Service<
  TraceStore,
  {
    /** Inserts a trace unless `(owner, id)` already exists; the first payload wins. */
    readonly insert: (trace: Trace) => Effect.Effect<boolean, TraceStoreError>;
    /** Newest first, at most {@link MAX_SEARCH_RESULTS}: exact session ID or summary substring. */
    readonly search: (
      owner: Owner,
      query: SearchQuery,
    ) => Effect.Effect<ReadonlyArray<Trace>, TraceStoreError>;
  }
>()("traces/TraceStore") {
  /** In-memory adapter for application tests. Mirrors D1's ordering and case-insensitive LIKE. */
  static readonly memory = Layer.sync(TraceStore, () => {
    const events = new Map<string, Trace>();
    return {
      insert: (trace) =>
        Effect.sync(() => {
          const key = JSON.stringify([trace.owner, trace.id]);
          if (events.has(key)) return false;
          events.set(key, trace);
          return true;
        }),
      search: (owner, query) =>
        Effect.sync(() => {
          // A search query is compared as text against both projected fields.
          const text: string = query;
          const needle = text.toLowerCase();
          return [...events.values()]
            .filter(
              (trace) =>
                trace.owner === owner &&
                (trace.sessionId === text || trace.summary.toLowerCase().includes(needle)),
            )
            .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || b.id.localeCompare(a.id))
            .slice(0, MAX_SEARCH_RESULTS);
        }),
    };
  });
}

export class Identity extends Context.Service<
  Identity,
  { readonly owner: Effect.Effect<Owner, Unauthenticated> }
>()("traces/Identity") {}

// The original payload is immutable; these fields are only a search projection.
export const normalize = (owner: Owner, input: Submission): Trace => {
  const raw = input.raw;
  const fields: Record<string, unknown> =
    typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const summary =
    typeof fields.tool_name === "string" || typeof fields.toolName === "string"
      ? String(fields.tool_name ?? fields.toolName)
      : input.event;
  return { ...input, owner, summary };
};

export const authorize = Effect.fn("Traces.authorize")(function* () {
  const identity = yield* Identity;
  return yield* identity.owner;
});

/**
 * Authorizes before reading the body, so unidentified callers never cause a parse.
 * Span attributes carry only the source and outcome, never payload fields.
 */
export const submitTrace = Effect.fn("Traces.submit")(function* (
  body: Effect.Effect<unknown, InvalidTraceEvent>,
) {
  const owner = yield* authorize();
  const input = yield* body.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Submission)),
    Effect.mapError(() => new InvalidTraceEvent()),
  );
  const length = JSON.stringify(input.raw).length;
  if (length > MAX_RAW_LENGTH)
    return yield* new TraceEventTooLarge({ length, limit: MAX_RAW_LENGTH });
  const store = yield* TraceStore;
  const inserted = yield* store.insert(normalize(owner, input));
  yield* Effect.annotateCurrentSpan({ "traces.source": input.source, "traces.inserted": inserted });
  return inserted;
});

/** The query itself stays off the span; it can be a session ID. */
export const searchTraces = Effect.fn("Traces.search")(function* (query: unknown) {
  const owner = yield* authorize();
  const decoded = yield* Schema.decodeUnknownEffect(SearchQuery)(query).pipe(
    Effect.mapError(() => new InvalidSearchQuery()),
  );
  const store = yield* TraceStore;
  const traces = yield* store.search(owner, decoded);
  yield* Effect.annotateCurrentSpan("traces.results", traces.length);
  return traces;
});
