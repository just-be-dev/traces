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
export const MAX_CONTENT_RESULTS = 20;
export const MAX_RAW_LENGTH = 64_000;
/** Traces the scheduled sweep indexes per run, bounded by {@link INDEX_BATCH_BYTES}. */
export const INDEX_BATCH_SIZE = 100;
/** Raw JSON the sweep loads per run; transcript entries can be up to 1 MB each. */
export const INDEX_BATCH_BYTES = 8_000_000;

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
  operation: Schema.Literals(["insert", "insertMany", "search", "get", "unindexed", "markIndexed"]),
  cause: Schema.Defect(),
}) {}

export class TraceIndexError extends Schema.TaggedError<TraceIndexError>()("TraceIndexError", {
  operation: Schema.Literals(["index", "search"]),
  cause: Schema.Defect(),
}) {}

const traceKey = (owner: Owner, id: EventId) => JSON.stringify([owner, id]);

const newestFirst = (a: Trace, b: Trace) =>
  b.occurredAt.localeCompare(a.occurredAt) || b.id.localeCompare(a.id);

export class TraceStore extends Context.Service<
  TraceStore,
  {
    /** Inserts a trace unless `(owner, id)` already exists; the first payload wins. */
    readonly insert: (trace: Trace) => Effect.Effect<boolean, TraceStoreError>;
    /**
     * Inserts each trace unless `(owner, id)` already exists, atomically. Returns how
     * many were new; repeats within the batch count once.
     */
    readonly insertMany: (traces: ReadonlyArray<Trace>) => Effect.Effect<number, TraceStoreError>;
    /** Newest first, at most {@link MAX_SEARCH_RESULTS}: exact session ID or summary substring. */
    readonly search: (
      owner: Owner,
      query: SearchQuery,
    ) => Effect.Effect<ReadonlyArray<Trace>, TraceStoreError>;
    /** The owner's traces with these IDs, in the order given. Unknown IDs are dropped. */
    readonly get: (
      owner: Owner,
      ids: ReadonlyArray<EventId>,
    ) => Effect.Effect<ReadonlyArray<Trace>, TraceStoreError>;
    /**
     * Stored traces the content index hasn't confirmed, newest first, across all owners:
     * at most `limit`, and only while their raw JSON totals at most `maxBytes`, except
     * that the newest one is always returned.
     */
    readonly unindexed: (
      limit: number,
      maxBytes: number,
    ) => Effect.Effect<ReadonlyArray<Trace>, TraceStoreError>;
    /** Records that the content index holds this trace. Repeating it is harmless. */
    readonly markIndexed: (owner: Owner, id: EventId) => Effect.Effect<void, TraceStoreError>;
  }
>()("traces/TraceStore") {
  /** In-memory adapter for application tests. Mirrors D1's ordering and case-insensitive LIKE. */
  static readonly memory = Layer.sync(TraceStore, () => {
    const events = new Map<string, Trace>();
    const indexed = new Set<string>();
    return {
      insert: (trace) =>
        Effect.sync(() => {
          const key = traceKey(trace.owner, trace.id);
          if (events.has(key)) return false;
          events.set(key, trace);
          return true;
        }),
      insertMany: (traces) =>
        Effect.sync(() => {
          let inserted = 0;
          for (const trace of traces) {
            const key = traceKey(trace.owner, trace.id);
            if (events.has(key)) continue;
            events.set(key, trace);
            inserted++;
          }
          return inserted;
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
            .sort(newestFirst)
            .slice(0, MAX_SEARCH_RESULTS);
        }),
      get: (owner, ids) =>
        Effect.sync(() =>
          ids.flatMap((id) => {
            const trace = events.get(traceKey(owner, id));
            return trace ? [trace] : [];
          }),
        ),
      unindexed: (limit, maxBytes) =>
        Effect.sync(() => {
          const pending = [...events.entries()]
            .filter(([key]) => !indexed.has(key))
            .map(([, trace]) => trace)
            .sort(newestFirst)
            .slice(0, limit);
          let running = 0;
          return pending.filter((trace, index) => {
            running += new TextEncoder().encode(JSON.stringify(trace.raw)).length;
            return index === 0 || running <= maxBytes;
          });
        }),
      markIndexed: (owner, id) =>
        Effect.sync(() => {
          const key = traceKey(owner, id);
          if (events.has(key)) indexed.add(key);
        }),
    };
  });
}

/**
 * Plain-text projection of a trace for content search: the envelope, then one
 * `path: value` line per scalar in the raw payload, with strings unescaped so
 * prompts, commands, and file contents read as written.
 */
export const searchText = (trace: Trace): string => {
  const lines = [
    `source: ${trace.source}`,
    `session: ${trace.sessionId}`,
    `event: ${trace.event}`,
    `tool: ${trace.summary}`,
  ];
  const visit = (value: unknown, path: string): void => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}[${index}]`));
    } else if (typeof value === "object" && value !== null) {
      for (const [key, item] of Object.entries(value)) visit(item, path ? `${path}.${key}` : key);
    } else if (value !== null) {
      lines.push(`${path || "raw"}: ${String(value)}`);
    }
  };
  visit(trace.raw, "");
  return lines.join("\n");
};

const searchTerms = (query: SearchQuery) =>
  query
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 0);

/** Full-text index over trace contents. D1 stays the source of truth; this holds a derived copy. */
export class TraceIndex extends Context.Service<
  TraceIndex,
  {
    /** Upserts the trace's {@link searchText}, keyed by `(owner, id)`, so repeats are idempotent. */
    readonly index: (trace: Trace) => Effect.Effect<void, TraceIndexError>;
    /**
     * IDs of the owner's traces whose text contains every query term, best match
     * first, at most {@link MAX_CONTENT_RESULTS}.
     */
    readonly search: (
      owner: Owner,
      query: SearchQuery,
    ) => Effect.Effect<ReadonlyArray<EventId>, TraceIndexError>;
  }
>()("traces/TraceIndex") {
  /**
   * In-memory adapter for application tests. Like AI Search's trigram keyword
   * index, every term must appear as a case-insensitive substring. Ranks by
   * total term occurrences, then newest first.
   */
  static readonly memory = Layer.sync(TraceIndex, () => {
    const documents = new Map<string, { trace: Trace; text: string }>();
    return {
      index: (trace) =>
        Effect.sync(() => {
          documents.set(traceKey(trace.owner, trace.id), {
            trace,
            text: searchText(trace).toLowerCase(),
          });
        }),
      search: (owner, query) =>
        Effect.sync(() => {
          const terms = searchTerms(query);
          return [...documents.values()]
            .filter(
              ({ trace, text }) =>
                trace.owner === owner && terms.every((term) => text.includes(term)),
            )
            .map(({ trace, text }) => ({
              trace,
              hits: terms.reduce((total, term) => total + text.split(term).length - 1, 0),
            }))
            .sort((a, b) => b.hits - a.hits || newestFirst(a.trace, b.trace))
            .slice(0, MAX_CONTENT_RESULTS)
            .map(({ trace }) => trace.id);
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

// Adapter causes are driver and service messages, not payloads.
const logIndexFailure = (error: TraceIndexError | TraceStoreError) =>
  Effect.logWarning("Trace indexing deferred to the scheduled sweep", error.cause).pipe(
    Effect.annotateLogs({ "traces.operation": error.operation }),
  );

/** Uploads one stored trace's text, then records it so the sweep skips it. */
const indexStoredTrace = Effect.fn("Traces.index")(function* (trace: Trace) {
  const index = yield* TraceIndex;
  const store = yield* TraceStore;
  yield* index.index(trace);
  yield* store.markIndexed(trace.owner, trace.id);
});

/**
 * Authorizes before reading the body, so unidentified callers never cause a parse.
 * D1 is the source of truth: once the insert succeeds the submission succeeds. A new
 * trace is indexed immediately when possible; on failure it stays unindexed in D1 and
 * {@link indexPendingTraces} retries it. Span attributes carry only the source and
 * outcome, never payload fields.
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
  const trace = normalize(owner, input);
  const inserted = yield* store.insert(trace);
  const indexed = inserted
    ? yield* indexStoredTrace(trace).pipe(
        Effect.as(true),
        Effect.catch((error) => logIndexFailure(error).pipe(Effect.as(false))),
      )
    : false;
  yield* Effect.annotateCurrentSpan({
    "traces.source": input.source,
    "traces.inserted": inserted,
    "traces.indexed": indexed,
  });
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

/**
 * Full-text search over the owner's trace contents, best match first. The index
 * filters by owner, and the stored traces are then read back through the owner's
 * D1 scope, so a hit from another owner can never be returned. Hits whose trace is
 * missing from D1 are dropped. The query stays off the span.
 */
export const searchTraceContents = Effect.fn("Traces.searchContents")(function* (query: unknown) {
  const owner = yield* authorize();
  const decoded = yield* Schema.decodeUnknownEffect(SearchQuery)(query).pipe(
    Effect.mapError(() => new InvalidSearchQuery()),
  );
  const index = yield* TraceIndex;
  const ids = yield* index.search(owner, decoded);
  const store = yield* TraceStore;
  const traces = ids.length === 0 ? [] : yield* store.get(owner, ids);
  yield* Effect.annotateCurrentSpan("traces.results", traces.length);
  return traces;
});

/**
 * Scheduled sweep: indexes up to {@link INDEX_BATCH_SIZE} stored traces the content
 * index hasn't confirmed, newest first. It backfills traces stored before content
 * search existed and retries failed uploads. Runs may overlap or repeat safely,
 * because uploads upsert by `(owner, id)`. One failing trace doesn't stop the rest.
 */
export const indexPendingTraces = Effect.fn("Traces.indexPending")(function* () {
  const store = yield* TraceStore;
  const pending = yield* store.unindexed(INDEX_BATCH_SIZE, INDEX_BATCH_BYTES);
  const outcomes = yield* Effect.forEach(
    pending,
    (trace) =>
      indexStoredTrace(trace).pipe(
        Effect.as(true),
        Effect.catch((error) => logIndexFailure(error).pipe(Effect.as(false))),
      ),
    { concurrency: 8 },
  );
  const indexed = outcomes.filter(Boolean).length;
  const failed = outcomes.length - indexed;
  yield* Effect.annotateCurrentSpan({ "traces.indexed": indexed, "traces.failed": failed });
  return { indexed, failed };
});
