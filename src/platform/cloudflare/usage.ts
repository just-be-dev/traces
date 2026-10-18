import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Trace } from "../../traces.ts";
import {
  MAX_BREAKDOWN,
  type Usage,
  UsageAggregates,
  UsageCursor,
  USAGE_EVENTS,
  UsageStore,
  UsageStoreError,
  type UtcOffset,
} from "../../usage.ts";
import type { D1Statements } from "./traces.ts";

// --- Sweep -------------------------------------------------------------------------

const SweepRow = Schema.Struct({ cursor: Schema.Int, head: Schema.NullOr(Schema.Int) });

const SWEEP_POSITION =
  "SELECT cursor, (SELECT MAX(rowid) FROM events) AS head FROM usage_sweep WHERE id = 1";

// Candidates are bounded by the head read just before, so rows stored meanwhile wait
// for the next run. One placeholder per USAGE_EVENTS entry; tests check they line up.
const BACKLOG = `WITH candidates AS (
    SELECT rowid AS position, length(CAST(raw AS BLOB)) AS size FROM events
    WHERE rowid > ? AND rowid <= ? AND event IN (?, ?, ?, ?)
    ORDER BY rowid LIMIT ?
  ), budgeted AS (
    SELECT position,
      SUM(size) OVER (ORDER BY position ROWS UNBOUNDED PRECEDING) AS running,
      ROW_NUMBER() OVER (ORDER BY position) AS n
    FROM candidates
  )
  SELECT b.position, (SELECT COUNT(*) FROM candidates) AS candidates,
    e.owner, e.id, e.source, e.session_id, e.event, e.occurred_at, e.summary, e.raw
  FROM budgeted b JOIN events e ON e.rowid = b.position
  WHERE b.running <= ? OR b.n = 1
  ORDER BY b.position`;

const BacklogRow = Schema.Struct({
  position: Schema.Int,
  candidates: Schema.Int,
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

// A row that no longer decodes has no usage to project; the sweep passes over it.
const decodeTrace = (row: typeof BacklogRow.Type) =>
  Effect.gen(function* () {
    return yield* Schema.decodeUnknownEffect(Trace)({
      owner: row.owner,
      id: row.id,
      source: row.source,
      sessionId: row.session_id,
      event: row.event,
      occurredAt: row.occurred_at,
      summary: row.summary,
      raw: yield* Schema.decodeEffect(RawJson)(row.raw),
    });
  }).pipe(Effect.option);

// The cursor never moves backwards, so an overlapping slower run can't undo progress.
const ADVANCE = "UPDATE usage_sweep SET cursor = MAX(cursor, ?) WHERE id = 1";

// A record without a model inherits the session's latest recorded one. Statements in
// a batch run in order in one transaction, so earlier records in the batch count.
const RECORD = `INSERT OR IGNORE INTO usage_records (
    owner, key, event_id, source, session_id, occurred_at, model,
    input_tokens, output_tokens, cache_read_tokens, cache_write_tokens
  ) VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, (
    SELECT model FROM usage_records
    WHERE owner = ? AND source = ? AND session_id = ? AND model IS NOT NULL
    ORDER BY occurred_at DESC LIMIT 1
  )), ?, ?, ?, ?)`;

const bindUsage = (d1: D1Statements, usage: Usage) =>
  d1
    .prepare(RECORD)
    .bind(
      usage.owner,
      usage.key,
      usage.eventId,
      usage.source,
      usage.sessionId,
      usage.occurredAt,
      usage.model ?? null,
      usage.owner,
      usage.source,
      usage.sessionId,
      usage.inputTokens,
      usage.outputTokens,
      usage.cacheReadTokens,
      usage.cacheWriteTokens,
    );

const SWEEP_CURSOR = "SELECT cursor FROM usage_sweep WHERE id = 1";

// --- Snapshots ---------------------------------------------------------------------

const SnapshotRow = Schema.Struct({ snapshot: Schema.String });
const READ_SNAPSHOT = "SELECT snapshot FROM usage_snapshots WHERE owner = ?";
// ISO instants of one format compare correctly as text.
const WRITE_SNAPSHOT = `INSERT INTO usage_snapshots (owner, generated_at, snapshot) VALUES (?, ?, ?)
  ON CONFLICT (owner) DO UPDATE SET generated_at = excluded.generated_at, snapshot = excluded.snapshot
  WHERE excluded.generated_at >= usage_snapshots.generated_at`;

// --- Aggregation -------------------------------------------------------------------

const TOKEN_SUMS = `SUM(input_tokens) AS inputTokens, SUM(output_tokens) AS outputTokens,
  SUM(cache_read_tokens) AS cacheReadTokens, SUM(cache_write_tokens) AS cacheWriteTokens`;
const TOKEN_TOTAL = "SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens)";

const DAYS = `SELECT date(occurred_at, ?) AS day, COUNT(*) AS responses,
    COUNT(DISTINCT session_id) AS sessions, ${TOKEN_SUMS}
  FROM usage_records WHERE owner = ? AND occurred_at >= ?
  GROUP BY day HAVING day IS NOT NULL ORDER BY day`;

const HOURS = `SELECT CAST(strftime('%H', occurred_at, ?) AS INTEGER) AS hour, COUNT(*) AS responses
  FROM usage_records WHERE owner = ? AND occurred_at >= ?
  GROUP BY hour HAVING hour IS NOT NULL`;

// Sources are fixed identifiers without commas, so group_concat's list splits cleanly.
const MODELS = `SELECT model, group_concat(DISTINCT source) AS sources, COUNT(*) AS responses,
    ${TOKEN_SUMS}
  FROM usage_records WHERE owner = ? AND occurred_at >= ?
  GROUP BY model ORDER BY responses DESC, ${TOKEN_TOTAL} DESC LIMIT ${MAX_BREAKDOWN}`;

const SOURCES = `SELECT source, COUNT(*) AS responses, COUNT(DISTINCT session_id) AS sessions, ${TOKEN_SUMS}
  FROM usage_records WHERE owner = ? AND occurred_at >= ?
  GROUP BY source ORDER BY responses DESC, ${TOKEN_TOTAL} DESC`;

const SESSIONS = `SELECT COUNT(DISTINCT session_id) AS sessions
  FROM usage_records WHERE owner = ? AND occurred_at >= ?`;

const TokenColumns = {
  inputTokens: Schema.Int,
  outputTokens: Schema.Int,
  cacheReadTokens: Schema.Int,
  cacheWriteTokens: Schema.Int,
};
const DayRow = Schema.Struct({
  day: Schema.String,
  responses: Schema.Int,
  sessions: Schema.Int,
  ...TokenColumns,
});
const HourRow = Schema.Struct({ hour: Schema.Int, responses: Schema.Int });
const ModelRow = Schema.Struct({
  sources: Schema.String,
  model: Schema.NullOr(Schema.String),
  responses: Schema.Int,
  ...TokenColumns,
});
const SourceRow = Schema.Struct({
  source: Schema.String,
  responses: Schema.Int,
  sessions: Schema.Int,
  ...TokenColumns,
});
const SessionsRow = Schema.Struct({ sessions: Schema.Int });

/** SQLite date modifier for a UTC offset, e.g. `+60 minutes`. */
export const offsetModifier = (offset: UtcOffset) => `${offset >= 0 ? "+" : ""}${offset} minutes`;

/**
 * D1 adapter. Native failures and rows that don't decode become typed
 * UsageStoreErrors; their causes are SQL and driver messages, never payloads.
 */
export const usage = (raw: Effect.Effect<D1Statements>) => {
  const query = <S extends Schema.Top>(
    operation: UsageStoreError["operation"],
    schema: S,
    sql: string,
    values: Array<unknown>,
  ) =>
    Effect.gen(function* () {
      const d1 = yield* raw;
      const result = yield* Effect.tryPromise({
        try: () =>
          d1
            .prepare(sql)
            .bind(...values)
            .all(),
        catch: (cause) => new UsageStoreError({ operation, cause }),
      });
      return yield* Schema.decodeUnknownEffect(Schema.Array(schema))(result.results).pipe(
        Effect.mapError((cause) => new UsageStoreError({ operation, cause })),
      );
    });

  const run = (operation: UsageStoreError["operation"], sql: string, values: Array<unknown>) =>
    Effect.gen(function* () {
      const d1 = yield* raw;
      yield* Effect.tryPromise({
        try: () =>
          d1
            .prepare(sql)
            .bind(...values)
            .run(),
        catch: (cause) => new UsageStoreError({ operation, cause }),
      });
    });

  return Layer.succeed(UsageStore, {
    position: query("position", Schema.Struct({ cursor: Schema.Int }), SWEEP_CURSOR, []).pipe(
      Effect.map((rows) => UsageCursor.make(rows[0]?.cursor ?? 0)),
      Effect.withSpan("UsageStore.position"),
    ),
    readSnapshot: Effect.fn("UsageStore.readSnapshot")(function* (owner) {
      const rows = yield* query("readSnapshot", SnapshotRow, READ_SNAPSHOT, [owner]);
      const row = rows[0];
      if (!row) return Option.none();
      // A row that isn't JSON reads as missing, so it gets recomputed.
      return yield* Schema.decodeEffect(RawJson)(row.snapshot).pipe(Effect.option);
    }),
    writeSnapshot: Effect.fn("UsageStore.writeSnapshot")(function* (owner, snapshot) {
      yield* run("writeSnapshot", WRITE_SNAPSHOT, [
        owner,
        snapshot.generatedAt,
        JSON.stringify(snapshot),
      ]);
    }),
    backlog: Effect.fn("UsageStore.backlog")(function* (limit: number, maxBytes: number) {
      const [position] = yield* query("backlog", SweepRow, SWEEP_POSITION, []);
      if (!position)
        return yield* new UsageStoreError({ operation: "backlog", cause: "no sweep row" });
      if (position.head === null || position.head <= position.cursor)
        return { traces: [], cursor: UsageCursor.make(position.cursor) };
      const rows = yield* query("backlog", BacklogRow, BACKLOG, [
        position.cursor,
        position.head,
        ...USAGE_EVENTS,
        limit,
        maxBytes,
      ]);
      const last = rows.at(-1);
      // Everything up to the head was scanned unless the limit or byte budget cut it short.
      const complete = !last || (last.candidates < limit && rows.length === last.candidates);
      const traces: Array<Trace> = [];
      for (const row of rows) {
        const trace = yield* decodeTrace(row);
        if (Option.isSome(trace)) traces.push(trace.value);
      }
      return {
        traces,
        cursor: UsageCursor.make(complete ? position.head : last.position),
      };
    }),
    record: Effect.fn("UsageStore.record")(function* (
      records: ReadonlyArray<Usage>,
      cursor: UsageCursor,
    ) {
      const d1 = yield* raw;
      yield* Effect.tryPromise({
        try: () =>
          d1.batch([
            ...records.map((record) => bindUsage(d1, record)),
            d1.prepare(ADVANCE).bind(cursor),
          ]),
        catch: (cause) => new UsageStoreError({ operation: "record", cause }),
      });
    }),
    aggregate: Effect.fn("UsageStore.aggregate")(function* (owner, since, offset) {
      const modifier = offsetModifier(offset);
      const [days, hours, models, sources, sessions] = yield* Effect.all(
        [
          query("aggregate", DayRow, DAYS, [modifier, owner, since]),
          query("aggregate", HourRow, HOURS, [modifier, owner, since]),
          query("aggregate", ModelRow, MODELS, [owner, since]),
          query("aggregate", SourceRow, SOURCES, [owner, since]),
          query("aggregate", SessionsRow, SESSIONS, [owner, since]),
        ],
        { concurrency: "unbounded" },
      );
      const byHour = new Map(hours.map((row) => [row.hour, row.responses]));
      // Sources and days are stored as text; decoding the assembled result checks them.
      return yield* Schema.decodeUnknownEffect(UsageAggregates)({
        days,
        hours: Array.from({ length: 24 }, (_, hour) => byHour.get(hour) ?? 0),
        models: models.map(({ model, sources, ...row }) => ({
          ...row,
          ...(model === null ? {} : { model }),
          sources: sources.split(",").sort(),
        })),
        sources,
        sessions: sessions[0]?.sessions ?? 0,
      }).pipe(Effect.mapError((cause) => new UsageStoreError({ operation: "aggregate", cause })));
    }),
  });
};
