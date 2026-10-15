import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  EventId,
  Owner,
  SessionId,
  Source,
  type Trace,
  TraceStore,
  TraceStoreError,
} from "./traces.ts";

/**
 * LLM usage: one record per model response, projected from stored transcript
 * entries. The raw entries in D1 stay the source of truth; usage records are a
 * derived, rebuildable copy that the homepage aggregates.
 *
 * Each harness reports usage differently:
 * - Claude Code writes one entry per content block, each repeating the message's
 *   usage, so records are keyed by the API message ID. That also dedups history a
 *   resumed or forked session copies into its new file.
 * - pi reports usage on each assistant message, keyed by the provider's response
 *   ID (or the request timestamp) so forked sessions don't count twice.
 * - Codex reports `token_count` events with the response's usage and the running
 *   total. Some versions repeat an event, so records are keyed by the running total.
 *   The model comes from the preceding `turn_context`.
 */

/** Transcript event names that carry usage, or (Codex) the model for later usage. */
export const USAGE_EVENTS = [
  "assistant",
  "message/assistant",
  "event_msg/token_count",
  "turn_context",
] as const;

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** Tokens normalized across harnesses. `inputTokens` excludes cache reads and writes. */
export const Tokens = Schema.Struct({
  inputTokens: Count,
  outputTokens: Count,
  cacheReadTokens: Count,
  cacheWriteTokens: Count,
});
export type Tokens = typeof Tokens.Type;

export const Usage = Schema.Struct({
  ...Tokens.fields,
  owner: Owner,
  /** Identifies one model response within the owner's usage; repeats are ignored. */
  key: Schema.String,
  eventId: EventId,
  source: Source,
  sessionId: SessionId,
  occurredAt: Schema.String,
  model: Schema.optional(Schema.String),
});
export type Usage = typeof Usage.Type;

/** Position of the usage sweep in the stored traces. Opaque outside the adapter. */
export const UsageCursor = Schema.Int.pipe(Schema.brand("UsageCursor"));
export type UsageCursor = typeof UsageCursor.Type;

/** Local calendar day, `YYYY-MM-DD`. */
export const Day = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/));
export type Day = typeof Day.Type;

/** Minutes east of UTC, as in `-new Date().getTimezoneOffset()`. */
export const UtcOffset = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(-14 * 60),
  Schema.isLessThanOrEqualTo(14 * 60),
);
export type UtcOffset = typeof UtcOffset.Type;

const isTimeZone = (value: string) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
};

/** An IANA time zone the runtime knows, e.g. `America/New_York`. */
export const TimeZone = Schema.String.check(
  Schema.makeFilter((value) => isTimeZone(value) || "Unknown time zone"),
).pipe(Schema.brand("TimeZone"));
export type TimeZone = typeof TimeZone.Type;

/**
 * The zone's offset at an instant. Days in the window all use today's offset, so
 * across a daylight saving change, activity near midnight can land a day off.
 */
export const utcOffsetAt = (timeZone: TimeZone, ms: number): UtcOffset => {
  const name = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
    .formatToParts(ms)
    .find((part) => part.type === "timeZoneName")?.value;
  const match = name?.match(/^GMT([+-])(\d{2}):(\d{2})$/);
  if (!match) return 0;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === "-" ? -minutes : minutes;
};

/** Days in the activity window: 53 weeks, like GitHub's contribution graph. */
export const WINDOW_DAYS = 53 * 7;
export const MAX_BREAKDOWN = 8;
/** Traces the usage sweep reads per run, bounded by {@link USAGE_BATCH_BYTES}. */
export const USAGE_BATCH_SIZE = 500;
export const USAGE_BATCH_BYTES = 8_000_000;

export const DayActivity = Schema.Struct({
  ...Tokens.fields,
  day: Day,
  responses: Count,
  sessions: Count,
});
export type DayActivity = typeof DayActivity.Type;

export const ModelUsage = Schema.Struct({
  ...Tokens.fields,
  /** Absent when the harness didn't say which model answered. */
  model: Schema.optional(Schema.String),
  source: Source,
  responses: Count,
});
export type ModelUsage = typeof ModelUsage.Type;

export const SourceUsage = Schema.Struct({
  ...Tokens.fields,
  source: Source,
  responses: Count,
  sessions: Count,
});
export type SourceUsage = typeof SourceUsage.Type;

export const ToolUsage = Schema.Struct({ tool: Schema.String, calls: Count });
export type ToolUsage = typeof ToolUsage.Type;

/** What the store aggregates for one owner over a window of local days. */
export const UsageAggregates = Schema.Struct({
  /** Active days only, oldest first. */
  days: Schema.Array(DayActivity),
  /** Responses per local hour of day, 0–23. */
  hours: Schema.Array(Count),
  /** Most responses first. */
  models: Schema.Array(ModelUsage),
  sources: Schema.Array(SourceUsage),
  /** Distinct sessions with usage in the window. */
  sessions: Count,
});
export type UsageAggregates = typeof UsageAggregates.Type;

/** Public wire format of `GET /api/stats`. */
export const UsageStats = Schema.Struct({
  ...UsageAggregates.fields,
  /** First and last local day of the window, inclusive. */
  from: Day,
  to: Day,
  /** Most calls first, at most {@link MAX_BREAKDOWN}. */
  tools: Schema.Array(ToolUsage),
});
export type UsageStats = typeof UsageStats.Type;

export class UsageStoreError extends Schema.TaggedError<UsageStoreError>()("UsageStoreError", {
  operation: Schema.Literals([
    "backlog",
    "record",
    "aggregate",
    "position",
    "readSnapshot",
    "writeSnapshot",
  ]),
  cause: Schema.Defect(),
}) {}

// --- Extraction --------------------------------------------------------------------

const fields = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const text = (value: unknown) =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const count = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;

const total = (tokens: Tokens) =>
  tokens.inputTokens + tokens.outputTokens + tokens.cacheReadTokens + tokens.cacheWriteTokens;

/** The model a Codex `turn_context` entry switches to. */
export const turnModel = (trace: Trace): string | undefined =>
  trace.source === "codex" && trace.event === "turn_context"
    ? text(fields(fields(trace.raw)?.payload)?.model)
    : undefined;

interface Extracted extends Tokens {
  readonly key: string;
  readonly model: string | undefined;
}

const claudeUsage = (raw: unknown): Extracted | undefined => {
  const message = fields(fields(raw)?.message);
  const usage = fields(message?.usage);
  const id = text(message?.id);
  if (!usage || !id) return undefined;
  return {
    key: `claude-code:${id}`,
    model: text(message?.model),
    inputTokens: count(usage.input_tokens),
    outputTokens: count(usage.output_tokens),
    cacheReadTokens: count(usage.cache_read_input_tokens),
    cacheWriteTokens: count(usage.cache_creation_input_tokens),
  };
};

const piUsage = (trace: Trace): Extracted | undefined => {
  const message = fields(fields(trace.raw)?.message);
  const usage = fields(message?.usage);
  if (!usage) return undefined;
  const provider = text(message?.provider);
  const model = text(message?.model);
  const response =
    text(message?.responseId) ??
    (typeof message?.timestamp === "number" ? String(message.timestamp) : undefined);
  return {
    key: response ? `pi:${provider ?? ""}:${response}` : `pi:${trace.id}`,
    model,
    inputTokens: count(usage.input),
    outputTokens: count(usage.output),
    cacheReadTokens: count(usage.cacheRead),
    cacheWriteTokens: count(usage.cacheWrite),
  };
};

const codexUsage = (trace: Trace, model: string | undefined): Extracted | undefined => {
  const info = fields(fields(fields(trace.raw)?.payload)?.info);
  const last = fields(info?.last_token_usage);
  const running = count(fields(info?.total_token_usage)?.total_tokens);
  if (!last || running === 0) return undefined;
  // OpenAI counts cached input inside input_tokens; reasoning is inside output_tokens.
  const cacheRead = count(last.cached_input_tokens);
  const cacheWrite = count(last.cache_write_input_tokens);
  // Trace IDs end in the entry key; the rest names the session file.
  const stream = trace.id.slice(0, trace.id.lastIndexOf(":"));
  return {
    key: `${stream}:total=${running}`,
    model,
    inputTokens: Math.max(0, count(last.input_tokens) - cacheRead - cacheWrite),
    outputTokens: count(last.output_tokens),
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
  };
};

/**
 * The usage one stored trace reports, if any. Codex usage needs the model of the
 * session's latest `turn_context`, passed as `codexModel`. Responses that used no
 * tokens (such as Claude Code's synthetic messages) are skipped.
 */
export const traceUsage = (trace: Trace, codexModel?: string): Usage | undefined => {
  const extracted =
    trace.source === "claude-code" && trace.event === "assistant"
      ? claudeUsage(trace.raw)
      : trace.source === "pi" && trace.event === "message/assistant"
        ? piUsage(trace)
        : trace.source === "codex" && trace.event === "event_msg/token_count"
          ? codexUsage(trace, codexModel)
          : undefined;
  if (!extracted || total(extracted) === 0) return undefined;
  const { key, model, ...tokens } = extracted;
  return {
    ...tokens,
    owner: trace.owner,
    key,
    eventId: trace.id,
    source: trace.source,
    sessionId: trace.sessionId,
    occurredAt: trace.occurredAt,
    ...(model ? { model } : {}),
  };
};

/**
 * Usage of traces in stored order. Each Codex `turn_context` sets the model for
 * the session's later usage; usage before any `turn_context` in this slice is left
 * without a model, for the store to inherit from the session's earlier usage.
 */
export const usageOf = (traces: ReadonlyArray<Trace>): ReadonlyArray<Usage> => {
  const models = new Map<string, string>();
  const usage: Array<Usage> = [];
  for (const trace of traces) {
    const session = JSON.stringify([trace.owner, trace.sessionId]);
    const model = turnModel(trace);
    if (model) models.set(session, model);
    const found = traceUsage(trace, models.get(session));
    if (found) usage.push(found);
  }
  return usage;
};

// --- Aggregation -------------------------------------------------------------------

const MS_PER_DAY = 86_400_000;

const dayAt = (ms: number, offset: UtcOffset): Day =>
  new Date(ms + offset * 60_000).toISOString().slice(0, 10);

/** The local-day window ending today, and the UTC instant its first day starts. */
export const statsWindow = (now: number, offset: UtcOffset) => {
  const to = dayAt(now, offset);
  const from = dayAt(Date.parse(`${to}T00:00:00Z`) - (WINDOW_DAYS - 1) * MS_PER_DAY, 0);
  const since = new Date(Date.parse(`${from}T00:00:00Z`) - offset * 60_000).toISOString();
  return { from, to, since };
};

/** The local day of an ISO timestamp, or undefined when it doesn't parse. */
export const localDay = (occurredAt: string, offset: UtcOffset): Day | undefined => {
  const ms = Date.parse(occurredAt);
  return Number.isNaN(ms) ? undefined : dayAt(ms, offset);
};

const localHour = (occurredAt: string, offset: UtcOffset) =>
  new Date(Date.parse(occurredAt) + offset * 60_000).getUTCHours();

const zero: Tokens = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
const add = <A extends Tokens>(into: A, usage: Tokens): A => ({
  ...into,
  inputTokens: into.inputTokens + usage.inputTokens,
  outputTokens: into.outputTokens + usage.outputTokens,
  cacheReadTokens: into.cacheReadTokens + usage.cacheReadTokens,
  cacheWriteTokens: into.cacheWriteTokens + usage.cacheWriteTokens,
});

const byResponses = <A extends { readonly responses: number } & Tokens>(a: A, b: A) =>
  b.responses - a.responses || total(b) - total(a);

/**
 * Aggregates usage records already scoped to one owner and window. The memory
 * store uses it directly; the D1 store computes the same result in SQL.
 */
export const aggregate = (records: ReadonlyArray<Usage>, offset: UtcOffset): UsageAggregates => {
  const days = new Map<string, DayActivity & { ids: Set<string> }>();
  const models = new Map<string, ModelUsage>();
  const sources = new Map<string, SourceUsage & { ids: Set<string> }>();
  const hours = Array.from({ length: 24 }, () => 0);
  const sessions = new Set<string>();
  for (const usage of records) {
    const day = localDay(usage.occurredAt, offset);
    if (day === undefined) continue;
    sessions.add(usage.sessionId);
    const hour = localHour(usage.occurredAt, offset);
    hours[hour] = (hours[hour] ?? 0) + 1;
    const dayEntry = days.get(day) ?? { ...zero, day, responses: 0, sessions: 0, ids: new Set() };
    dayEntry.ids.add(usage.sessionId);
    days.set(day, { ...add(dayEntry, usage), responses: dayEntry.responses + 1 });
    const modelKey = JSON.stringify([usage.source, usage.model ?? null]);
    const modelEntry: ModelUsage = models.get(modelKey) ?? {
      ...zero,
      source: usage.source,
      ...(usage.model ? { model: usage.model } : {}),
      responses: 0,
    };
    models.set(modelKey, { ...add(modelEntry, usage), responses: modelEntry.responses + 1 });
    const sourceEntry = sources.get(usage.source) ?? {
      ...zero,
      source: usage.source,
      responses: 0,
      sessions: 0,
      ids: new Set(),
    };
    sourceEntry.ids.add(usage.sessionId);
    sources.set(usage.source, { ...add(sourceEntry, usage), responses: sourceEntry.responses + 1 });
  }
  return {
    days: [...days.values()]
      .map(({ ids, ...day }) => ({ ...day, sessions: ids.size }))
      .sort((a, b) => a.day.localeCompare(b.day)),
    hours,
    models: [...models.values()].sort(byResponses).slice(0, MAX_BREAKDOWN),
    sources: [...sources.values()]
      .map(({ ids, ...source }) => ({ ...source, sessions: ids.size }))
      .sort(byResponses),
    sessions: sessions.size,
  };
};

// --- Services ----------------------------------------------------------------------

export class UsageStore extends Context.Service<
  UsageStore,
  {
    /**
     * Stored traces after the sweep's cursor whose event is one of
     * {@link USAGE_EVENTS}, in stored order: at most `limit`, and only while their
     * raw JSON totals at most `maxBytes`, except that the first is always returned.
     * `cursor` is where the next sweep resumes once these are recorded.
     */
    readonly backlog: (
      limit: number,
      maxBytes: number,
    ) => Effect.Effect<
      { readonly traces: ReadonlyArray<Trace>; readonly cursor: UsageCursor },
      UsageStoreError
    >;
    /**
     * Atomically stores the usage records and moves the sweep's cursor. A record
     * whose `(owner, key)` exists is ignored, so the first one wins. A record without
     * a model inherits the latest model recorded for its owner, source, and session.
     */
    readonly record: (
      usage: ReadonlyArray<Usage>,
      cursor: UsageCursor,
    ) => Effect.Effect<void, UsageStoreError>;
    /** The owner's usage from `since` (an ISO instant), grouped by local day. */
    readonly aggregate: (
      owner: Owner,
      since: string,
      offset: UtcOffset,
    ) => Effect.Effect<UsageAggregates, UsageStoreError>;
    /** Where the sweep will resume. It only moves forward. */
    readonly position: Effect.Effect<UsageCursor, UsageStoreError>;
    /** The owner's last written stats snapshot as stored JSON, if any. */
    readonly readSnapshot: (owner: Owner) => Effect.Effect<Option.Option<unknown>, UsageStoreError>;
    /**
     * Replaces the owner's snapshot unless the stored one was generated later, so an
     * overlapping slower refresh can't overwrite newer stats.
     */
    readonly writeSnapshot: (
      owner: Owner,
      snapshot: StatsSnapshotEncoded,
    ) => Effect.Effect<void, UsageStoreError>;
  }
>()("traces/UsageStore") {
  /**
   * In-memory adapter for application tests. It sweeps the traces it is given with
   * `traces`, which stands in for the stored traces in stored order.
   */
  static readonly memoryWith = (traces: () => ReadonlyArray<Trace>) =>
    Layer.sync(UsageStore, () => {
      const records = new Map<string, Usage>();
      const snapshots = new Map<Owner, StatsSnapshotEncoded>();
      let position = 0;
      const events: ReadonlyArray<string> = USAGE_EVENTS;
      return {
        backlog: (limit, maxBytes) =>
          Effect.sync(() => {
            const all = traces();
            const picked: Array<Trace> = [];
            let bytes = 0;
            let cursor = position;
            for (const [index, trace] of all.entries()) {
              if (index < position) continue;
              if (picked.length >= limit) break;
              if (events.includes(trace.event)) {
                bytes += new TextEncoder().encode(JSON.stringify(trace.raw)).length;
                if (picked.length > 0 && bytes > maxBytes) break;
                picked.push(trace);
              }
              cursor = index + 1;
            }
            return { traces: picked, cursor: UsageCursor.make(cursor) };
          }),
        record: (usage, cursor) =>
          Effect.sync(() => {
            for (const record of usage) {
              const key = JSON.stringify([record.owner, record.key]);
              if (records.has(key)) continue;
              const inherited =
                record.model ??
                [...records.values()]
                  .filter(
                    (other) =>
                      other.owner === record.owner &&
                      other.source === record.source &&
                      other.sessionId === record.sessionId &&
                      other.model !== undefined,
                  )
                  .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))[0]?.model;
              records.set(key, { ...record, ...(inherited ? { model: inherited } : {}) });
            }
            position = cursor;
          }),
        aggregate: (owner, since, offset) =>
          Effect.sync(() =>
            aggregate(
              [...records.values()].filter(
                (usage) => usage.owner === owner && usage.occurredAt >= since,
              ),
              offset,
            ),
          ),
        position: Effect.sync(() => UsageCursor.make(position)),
        readSnapshot: (owner) => Effect.sync(() => Option.fromNullishOr(snapshots.get(owner))),
        writeSnapshot: (owner, snapshot) =>
          Effect.sync(() => {
            const stored = snapshots.get(owner);
            if (!stored || stored.generatedAt <= snapshot.generatedAt)
              snapshots.set(owner, snapshot);
          }),
      };
    });

  /** In-memory adapter with no stored traces to sweep. */
  static readonly memory = UsageStore.memoryWith(() => []);
}

/**
 * Scheduled sweep: projects usage from traces stored since the last run, in stored
 * order, then records it and advances the cursor in one step. Repeated or
 * overlapping runs are safe because records are keyed per response and the first
 * one wins. A failed run leaves the cursor in place, so the next run retries.
 */
export const recordPendingUsage = Effect.fn("Usage.recordPending")(function* () {
  const store = yield* UsageStore;
  const backlog = yield* store.backlog(USAGE_BATCH_SIZE, USAGE_BATCH_BYTES);
  const usage = usageOf(backlog.traces);
  yield* store.record(usage, backlog.cursor);
  yield* Effect.annotateCurrentSpan({
    "traces.scanned": backlog.traces.length,
    "traces.usage": usage.length,
  });
  return { scanned: backlog.traces.length, projected: usage.length };
});

/** Whose usage the public homepage shows, and in which time zone its days fall. */
export class Showcase extends Context.Service<
  Showcase,
  { readonly owner: Owner; readonly timeZone: TimeZone }
>()("traces/Showcase") {}

/** A precomputed {@link UsageStats}, so public requests never aggregate. */
export const StatsSnapshot = Schema.Struct({
  stats: UsageStats,
  /** ISO instant the stats were computed. */
  generatedAt: Schema.String,
  /** The sweep's position then: usage recorded since makes the snapshot stale. */
  cursor: UsageCursor,
});
export type StatsSnapshot = typeof StatsSnapshot.Type;
export type StatsSnapshotEncoded = typeof StatsSnapshot.Encoded;

/** Minimum age before new usage triggers a refresh, bounding aggregation cost. */
export const SNAPSHOT_REFRESH_MS = 5 * 60_000;

const computeStats = Effect.fn("Usage.compute")(function* (owner: Owner, timeZone: TimeZone) {
  const now = yield* Clock.currentTimeMillis;
  const offset = utcOffsetAt(timeZone, now);
  const window = statsWindow(now, offset);
  const usage = yield* (yield* UsageStore).aggregate(owner, window.since, offset);
  const tools = yield* (yield* TraceStore).tools(owner, window.since, MAX_BREAKDOWN);
  return { ...usage, from: window.from, to: window.to, tools } satisfies UsageStats;
});

/** Stats a stored snapshot holds, or none when it is missing or no longer decodes. */
const storedSnapshot = Effect.fn("Usage.readSnapshot")(function* (owner: Owner) {
  const stored = yield* (yield* UsageStore).readSnapshot(owner);
  if (Option.isNone(stored)) return Option.none<StatsSnapshot>();
  // A snapshot from an older schema is recomputed rather than served or failed on.
  return yield* Schema.decodeUnknownEffect(StatsSnapshot)(stored.value).pipe(Effect.option);
});

const writeStats = Effect.fn("Usage.writeSnapshot")(function* (owner: Owner, timeZone: TimeZone) {
  const store = yield* UsageStore;
  // Read the cursor first: usage recorded during aggregation then marks it stale.
  const cursor = yield* store.position;
  const stats = yield* computeStats(owner, timeZone);
  const generatedAt = new Date(yield* Clock.currentTimeMillis).toISOString();
  const snapshot: StatsSnapshot = { stats, generatedAt, cursor };
  const encoded = yield* Schema.encodeEffect(StatsSnapshot)(snapshot).pipe(
    Effect.mapError((cause) => new UsageStoreError({ operation: "writeSnapshot", cause })),
  );
  yield* store.writeSnapshot(owner, encoded);
  return snapshot;
});

/**
 * Scheduled refresh of the showcase owner's snapshot. Recomputes when there is no
 * usable snapshot, when the local day has changed, or when usage was recorded
 * since and the snapshot is at least {@link SNAPSHOT_REFRESH_MS} old.
 */
export const refreshUsageStats = Effect.fn("Usage.refresh")(function* () {
  const { owner, timeZone } = yield* Showcase;
  const now = yield* Clock.currentTimeMillis;
  const current = yield* storedSnapshot(owner);
  const position = yield* (yield* UsageStore).position;
  const stale = Option.match(current, {
    onNone: () => true,
    onSome: (snapshot) =>
      snapshot.stats.to !== statsWindow(now, utcOffsetAt(timeZone, now)).to ||
      (position > snapshot.cursor && now - Date.parse(snapshot.generatedAt) >= SNAPSHOT_REFRESH_MS),
  });
  yield* Effect.annotateCurrentSpan("traces.refreshed", stale);
  if (stale) yield* writeStats(owner, timeZone);
  return stale;
});

/**
 * The showcase owner's usage over the last {@link WINDOW_DAYS} days, public by
 * design. Served from the snapshot; only the first request after deploy (or after
 * a snapshot stops decoding) computes it. Raw traces, prompts, and project paths
 * are never part of it.
 */
export const publicUsageStats = Effect.fn("Usage.public")(function* () {
  const { owner, timeZone } = yield* Showcase;
  const current = yield* storedSnapshot(owner);
  return Option.isSome(current) ? current.value : yield* writeStats(owner, timeZone);
});

export type UsageStatsError = UsageStoreError | TraceStoreError;
