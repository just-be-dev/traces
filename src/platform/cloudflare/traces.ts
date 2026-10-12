import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  type EventId,
  Identity,
  MAX_SEARCH_RESULTS,
  Owner,
  Trace,
  TraceStore,
  TraceStoreError,
  Unauthenticated,
} from "../../traces.ts";

export const Database = Cloudflare.D1.Database("Traces", { migrations: "migrations" });

// Columns of `events` that make up a Trace (migrations/0001_events.sql). `indexed_at`
// (0002_content_index.sql) is bookkeeping for the content index and never leaves D1.
const StoredTrace = Schema.Struct({
  owner: Schema.String,
  id: Schema.String,
  source: Schema.String,
  session_id: Schema.String,
  event: Schema.String,
  occurred_at: Schema.String,
  summary: Schema.String,
  raw: Schema.String,
});

const RawJson = Schema.fromJsonString(Schema.Json);

const decodeStoredTrace = (row: unknown) =>
  Effect.gen(function* () {
    const stored = yield* Schema.decodeUnknownEffect(StoredTrace)(row);
    return yield* Schema.decodeUnknownEffect(Trace)({
      owner: stored.owner,
      id: stored.id,
      source: stored.source,
      sessionId: stored.session_id,
      event: stored.event,
      occurredAt: stored.occurred_at,
      summary: stored.summary,
      raw: yield* Schema.decodeEffect(RawJson)(stored.raw),
    });
  });

const TRACE_COLUMNS = "owner, id, source, session_id, event, occurred_at, summary, raw";

// A row that no longer decodes is skipped and logged by event ID only. The raw
// column stays in D1 untouched so a later schema or migration can reinterpret it.
// The content-index sweep reads newest first, so such rows can't starve new traces.
const decodeSearchResults = Effect.fn("TraceStore.decodeResults")(function* (
  rows: ReadonlyArray<unknown>,
) {
  const traces: Array<Trace> = [];
  for (const row of rows) {
    const decoded = yield* Effect.option(decodeStoredTrace(row));
    if (Option.isSome(decoded)) {
      traces.push(decoded.value);
      continue;
    }
    const id = typeof row === "object" && row !== null && "id" in row ? String(row.id) : "unknown";
    yield* Effect.logWarning("Skipped stored trace that no longer decodes").pipe(
      Effect.annotateLogs({ "traces.event_id": id }),
    );
  }
  if (traces.length < rows.length)
    yield* Effect.annotateCurrentSpan("traces.undecodable", rows.length - traces.length);
  return traces;
});

/** The part of the native D1 binding this adapter uses. */
export interface D1Statements {
  prepare(query: string): {
    bind(...values: Array<unknown>): {
      run(): Promise<{ readonly meta: { readonly changes: number } }>;
      all(): Promise<{ readonly results: ReadonlyArray<unknown> }>;
    };
  };
}

/**
 * D1's Effect client turns query failures into defects, so this adapter takes the
 * raw binding and surfaces them as a typed TraceStoreError the application answers.
 */
export const storage = (raw: Effect.Effect<D1Statements>) =>
  Layer.succeed(TraceStore, {
    insert: Effect.fn("TraceStore.insert")(function* (trace) {
      const d1 = yield* raw;
      const result = yield* Effect.tryPromise({
        try: () =>
          d1
            .prepare(
              "INSERT OR IGNORE INTO events (owner, id, source, session_id, event, occurred_at, summary, raw) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(
              trace.owner,
              trace.id,
              trace.source,
              trace.sessionId,
              trace.event,
              trace.occurredAt,
              trace.summary,
              JSON.stringify(trace.raw),
            )
            .run(),
        catch: (cause) => new TraceStoreError({ operation: "insert", cause }),
      });
      return result.meta.changes > 0;
    }),
    search: Effect.fn("TraceStore.search")(function* (owner, query) {
      const d1 = yield* raw;
      const text: string = query;
      const result = yield* Effect.tryPromise({
        try: () =>
          d1
            .prepare(
              `SELECT ${TRACE_COLUMNS} FROM events WHERE owner = ? AND (session_id = ? OR summary LIKE ? ESCAPE '\\') ORDER BY occurred_at DESC, id DESC LIMIT ${MAX_SEARCH_RESULTS}`,
            )
            .bind(owner, text, `%${text.replace(/[\\%_]/g, "\\$&")}%`)
            .all(),
        catch: (cause) => new TraceStoreError({ operation: "search", cause }),
      });
      return yield* decodeSearchResults(result.results);
    }),
    get: Effect.fn("TraceStore.get")(function* (owner: Owner, ids: ReadonlyArray<EventId>) {
      if (ids.length === 0) return [];
      const d1 = yield* raw;
      const result = yield* Effect.tryPromise({
        try: () =>
          d1
            .prepare(
              `SELECT ${TRACE_COLUMNS} FROM events WHERE owner = ? AND id IN (${ids.map(() => "?").join(", ")})`,
            )
            .bind(owner, ...ids)
            .all(),
        catch: (cause) => new TraceStoreError({ operation: "get", cause }),
      });
      const traces = yield* decodeSearchResults(result.results);
      // Restore the caller's ranking; IN () returns rows in storage order.
      const byId = new Map<EventId, Trace>(traces.map((trace) => [trace.id, trace]));
      return ids.flatMap((id) => {
        const trace = byId.get(id);
        return trace ? [trace] : [];
      });
    }),
    unindexed: Effect.fn("TraceStore.unindexed")(function* (limit: number) {
      const d1 = yield* raw;
      const result = yield* Effect.tryPromise({
        try: () =>
          d1
            .prepare(
              `SELECT ${TRACE_COLUMNS} FROM events WHERE indexed_at IS NULL ORDER BY occurred_at DESC, id DESC LIMIT ?`,
            )
            .bind(limit)
            .all(),
        catch: (cause) => new TraceStoreError({ operation: "unindexed", cause }),
      });
      return yield* decodeSearchResults(result.results);
    }),
    markIndexed: Effect.fn("TraceStore.markIndexed")(function* (owner: Owner, id: EventId) {
      const d1 = yield* raw;
      yield* Effect.tryPromise({
        try: () =>
          d1
            .prepare(
              "UPDATE events SET indexed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE owner = ? AND id = ?",
            )
            .bind(owner, id)
            .run(),
        catch: (cause) => new TraceStoreError({ operation: "markIndexed", cause }),
      });
    }),
  });

// Single tenant: Access admits only the configured owner email or service token, and
// service-token requests carry no user email, so every admitted request maps to one owner.
const singleOwner = Owner.make("owner");

/** `access` is the request's Access context, present only once a policy admitted it. */
export const identity = (access: Effect.Effect<{ readonly aud: string } | undefined>) =>
  Layer.succeed(Identity, {
    owner: Effect.gen(function* () {
      if (!(yield* access)) return yield* new Unauthenticated();
      return singleOwner;
    }).pipe(Effect.withSpan("Identity.owner")),
  });
