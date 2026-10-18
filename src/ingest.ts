import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  authorize,
  EventId,
  EventName,
  type Owner,
  SessionId,
  type Trace,
  TraceEventTooLarge,
  TraceStore,
  Unauthenticated,
} from "./traces.ts";

/**
 * Transcript ingest. An uploader is a credential for one machine's harness: the
 * owner creates it over MCP (Access-authenticated), which yields a short-lived
 * single-use claim code; the local uploader exchanges the code for a long-lived
 * bearer token. Only SHA-256 digests of codes and tokens are stored. The token can
 * only append transcript entries to its owner's traces; it can't read anything.
 *
 * Each upload is an incremental slice of a harness's session JSONL file. Every
 * line becomes one trace with a deterministic ID, so re-sending a slice is a no-op
 * and the first payload wins.
 */

const Bounded = (max: number) =>
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(max));

export const Harness = Schema.Literals(["claude-code", "codex", "pi", "omp"]);
export type Harness = typeof Harness.Type;

/** pi and its fork omp (oh-my-pi) share the session entry format. */
const isPiFamily = (harness: Harness) => harness === "pi" || harness === "omp";

export const UploaderId = Schema.String.check(Schema.isPattern(/^upl_[0-9a-f]{16}$/)).pipe(
  Schema.brand("UploaderId"),
);
export type UploaderId = typeof UploaderId.Type;

/** Largest JSON-encoded transcript entry, in UTF-8 bytes. D1 rows top out at 2 MB. */
export const MAX_ENTRY_BYTES = 1_000_000;
export const MAX_BATCH_ENTRIES = 500;
/** Largest ingest request body, and total JSON-encoded entry bytes per batch. */
export const MAX_BATCH_BYTES = 8_000_000;
export const CLAIM_TTL_MS = 10 * 60 * 1000;
export const MAX_RECENT_SESSIONS = 50;

export const IngestBatch = Schema.Struct({
  client: Schema.Struct({
    harness: Harness,
    harnessVersion: Schema.optional(Bounded(100)),
    uploaderVersion: Bounded(50),
    host: Schema.optional(Bounded(255)),
    platform: Schema.optional(Bounded(50)),
  }),
  session: Schema.Struct({
    id: Bounded(200),
    /** The file within the session, e.g. a Claude Code subagent transcript. */
    stream: Bounded(200),
    cwd: Schema.optional(Bounded(4096)),
  }),
  entries: Schema.Array(
    Schema.Struct({
      /** Byte offset of the line in the source file. */
      offset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      raw: Schema.Json,
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(MAX_BATCH_ENTRIES)),
});
export type IngestBatch = typeof IngestBatch.Type;

export const NewUploaderInput = Schema.Struct({
  harness: Harness,
  label: Schema.optional(Bounded(100)),
});

const ClaimRequest = Schema.Struct({
  code: Schema.String.check(Schema.isPattern(/^tcl_[0-9a-f]{32}$/)),
});

export const Uploader = Schema.Struct({
  id: UploaderId,
  label: Schema.String,
  harness: Harness,
  createdAt: Schema.String,
  claimedAt: Schema.optional(Schema.String),
  lastUsedAt: Schema.optional(Schema.String),
  revokedAt: Schema.optional(Schema.String),
});
export type Uploader = typeof Uploader.Type;

/** What the server knows about a session from its uploads: the provenance of its traces. */
export const SessionRecord = Schema.Struct({
  source: Harness,
  sessionId: SessionId,
  harnessVersion: Schema.optional(Schema.String),
  uploaderVersion: Schema.String,
  uploaderId: UploaderId,
  host: Schema.optional(Schema.String),
  platform: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.String),
  /** Entries newly stored by uploads. Best effort: a retried upload after a failed write may undercount. */
  entries: Schema.Int,
  firstUploadedAt: Schema.String,
  lastUploadedAt: Schema.String,
});
export type SessionRecord = typeof SessionRecord.Type;

export class InvalidIngestBatch extends Schema.TaggedError<InvalidIngestBatch>()(
  "InvalidIngestBatch",
  {},
) {}

export class InvalidUploaderInput extends Schema.TaggedError<InvalidUploaderInput>()(
  "InvalidUploaderInput",
  {},
) {}

/** Unknown, expired, already used, or revoked. Deliberately indistinguishable. */
export class InvalidClaimCode extends Schema.TaggedError<InvalidClaimCode>()(
  "InvalidClaimCode",
  {},
) {}

export class IngestStoreError extends Schema.TaggedError<IngestStoreError>()("IngestStoreError", {
  operation: Schema.Literals([
    "createUploader",
    "claimUploader",
    "authenticateUploader",
    "listUploaders",
    "revokeUploader",
    "recordSession",
    "recentSessions",
  ]),
  cause: Schema.Defect(),
}) {}

export interface NewUploader {
  readonly owner: Owner;
  readonly id: UploaderId;
  readonly label: string;
  readonly harness: Harness;
  readonly claimHash: string;
  readonly claimExpiresAt: string;
  readonly createdAt: string;
}

export interface UploaderPrincipal {
  readonly owner: Owner;
  readonly id: UploaderId;
}

export interface SessionUpload {
  readonly owner: Owner;
  readonly source: Harness;
  readonly sessionId: SessionId;
  readonly harnessVersion: string | undefined;
  readonly uploaderVersion: string;
  readonly uploaderId: UploaderId;
  readonly host: string | undefined;
  readonly platform: string | undefined;
  readonly cwd: string | undefined;
  readonly inserted: number;
  readonly at: string;
}

export class UploaderStore extends Context.Service<
  UploaderStore,
  {
    readonly create: (uploader: NewUploader) => Effect.Effect<void, IngestStoreError>;
    /**
     * Atomically consumes an unexpired, unrevoked claim and sets the token digest.
     * A claim succeeds at most once.
     */
    readonly claim: (
      claimHash: string,
      tokenHash: string,
      now: string,
    ) => Effect.Effect<Option.Option<UploaderPrincipal>, IngestStoreError>;
    /** The unrevoked uploader holding this token digest; records the use. */
    readonly authenticate: (
      tokenHash: string,
      now: string,
    ) => Effect.Effect<Option.Option<UploaderPrincipal>, IngestStoreError>;
    /** Newest first. */
    readonly list: (owner: Owner) => Effect.Effect<ReadonlyArray<Uploader>, IngestStoreError>;
    /** False when the owner has no such unrevoked uploader. Also voids an unused claim. */
    readonly revoke: (
      owner: Owner,
      id: UploaderId,
      now: string,
    ) => Effect.Effect<boolean, IngestStoreError>;
  }
>()("traces/UploaderStore") {
  static readonly memory = Layer.sync(UploaderStore, () => {
    interface Row extends Omit<NewUploader, "claimHash"> {
      claimHash: string | undefined;
      tokenHash?: string;
      claimedAt?: string;
      lastUsedAt?: string;
      revokedAt?: string;
    }
    const rows = new Map<UploaderId, Row>();
    const toUploader = (row: Row): Uploader => ({
      id: row.id,
      label: row.label,
      harness: row.harness,
      createdAt: row.createdAt,
      ...(row.claimedAt ? { claimedAt: row.claimedAt } : {}),
      ...(row.lastUsedAt ? { lastUsedAt: row.lastUsedAt } : {}),
      ...(row.revokedAt ? { revokedAt: row.revokedAt } : {}),
    });
    return {
      create: (uploader) =>
        Effect.sync(() => {
          rows.set(uploader.id, { ...uploader });
        }),
      claim: (claimHash, tokenHash, now) =>
        Effect.sync(() => {
          for (const row of rows.values()) {
            if (
              row.claimHash === claimHash &&
              row.tokenHash === undefined &&
              row.revokedAt === undefined &&
              row.claimExpiresAt > now
            ) {
              row.claimHash = undefined;
              row.tokenHash = tokenHash;
              row.claimedAt = now;
              return Option.some({ owner: row.owner, id: row.id });
            }
          }
          return Option.none();
        }),
      authenticate: (tokenHash, now) =>
        Effect.sync(() => {
          for (const row of rows.values()) {
            if (row.tokenHash === tokenHash && row.revokedAt === undefined) {
              row.lastUsedAt = now;
              return Option.some({ owner: row.owner, id: row.id });
            }
          }
          return Option.none();
        }),
      list: (owner) =>
        Effect.sync(() =>
          [...rows.values()]
            .filter((row) => row.owner === owner)
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
            .map(toUploader),
        ),
      revoke: (owner, id, now) =>
        Effect.sync(() => {
          const row = rows.get(id);
          if (!row || row.owner !== owner || row.revokedAt !== undefined) return false;
          row.revokedAt = now;
          row.claimHash = undefined;
          return true;
        }),
    };
  });
}

export class SessionStore extends Context.Service<
  SessionStore,
  {
    /** Upserts the session's provenance and adds `inserted` to its entry count. */
    readonly record: (upload: SessionUpload) => Effect.Effect<void, IngestStoreError>;
    /** Most recently uploaded first, at most {@link MAX_RECENT_SESSIONS}. */
    readonly recent: (
      owner: Owner,
    ) => Effect.Effect<ReadonlyArray<SessionRecord>, IngestStoreError>;
  }
>()("traces/SessionStore") {
  static readonly memory = Layer.sync(SessionStore, () => {
    const rows = new Map<string, { owner: Owner; record: SessionRecord }>();
    return {
      record: (upload) =>
        Effect.sync(() => {
          const key = JSON.stringify([upload.owner, upload.source, upload.sessionId]);
          const previous = rows.get(key)?.record;
          const optional = (name: string, value: string | undefined, fallback?: string) => {
            const chosen = value ?? fallback;
            return chosen === undefined ? {} : { [name]: chosen };
          };
          const record: SessionRecord = {
            source: upload.source,
            sessionId: upload.sessionId,
            uploaderVersion: upload.uploaderVersion,
            uploaderId: upload.uploaderId,
            ...optional("harnessVersion", upload.harnessVersion, previous?.harnessVersion),
            ...optional("host", upload.host, previous?.host),
            ...optional("platform", upload.platform, previous?.platform),
            ...optional("cwd", upload.cwd, previous?.cwd),
            entries: (previous?.entries ?? 0) + upload.inserted,
            firstUploadedAt: previous?.firstUploadedAt ?? upload.at,
            lastUploadedAt: upload.at,
          };
          rows.set(key, { owner: upload.owner, record });
        }),
      recent: (owner) =>
        Effect.sync(() =>
          [...rows.values()]
            .filter((row) => row.owner === owner)
            .map((row) => row.record)
            .sort((a, b) => b.lastUploadedAt.localeCompare(a.lastUploadedAt))
            .slice(0, MAX_RECENT_SESSIONS),
        ),
    };
  });
}

// --- Credentials -----------------------------------------------------------------

const randomHex = (bytes: number) =>
  Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

/** SHA-256 hex digest. Codes and tokens are 128+ random bits, so no salt is needed. */
export const digest = (value: string) =>
  Effect.promise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))).pipe(
    Effect.map((buffer) =>
      Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join(""),
    ),
  );

const nowIso = Clock.currentTimeMillis.pipe(Effect.map((ms) => new Date(ms).toISOString()));

const BEARER = /^Bearer\s+(trc_[0-9a-f]{64})$/;

/** Creates a pending uploader for the Access-authenticated owner and returns its one-time claim code. */
export const createUploader = Effect.fn("Ingest.createUploader")(function* (input: unknown) {
  const owner = yield* authorize();
  const decoded = yield* Schema.decodeUnknownEffect(NewUploaderInput)(input).pipe(
    Effect.mapError(() => new InvalidUploaderInput()),
  );
  const store = yield* UploaderStore;
  const now = yield* Clock.currentTimeMillis;
  const id = UploaderId.make(`upl_${randomHex(8)}`);
  const claimCode = `tcl_${randomHex(16)}`;
  const expiresAt = new Date(now + CLAIM_TTL_MS).toISOString();
  yield* store.create({
    owner,
    id,
    label: decoded.label ?? decoded.harness,
    harness: decoded.harness,
    claimHash: yield* digest(claimCode),
    claimExpiresAt: expiresAt,
    createdAt: new Date(now).toISOString(),
  });
  yield* Effect.annotateCurrentSpan("traces.harness", decoded.harness);
  return { uploaderId: id, claimCode, expiresAt };
});

/**
 * Exchanges a claim code for the uploader's bearer token. Public: the code is the
 * credential. The token is returned once and only its digest is kept.
 */
export const claimUploader = Effect.fn("Ingest.claimUploader")(function* (
  body: Effect.Effect<unknown, InvalidClaimCode>,
) {
  const request = yield* body.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(ClaimRequest)),
    Effect.mapError(() => new InvalidClaimCode()),
  );
  const store = yield* UploaderStore;
  const token = `trc_${randomHex(32)}`;
  const claimed = yield* store.claim(
    yield* digest(request.code),
    yield* digest(token),
    yield* nowIso,
  );
  if (Option.isNone(claimed)) return yield* new InvalidClaimCode();
  return { uploaderId: claimed.value.id, token };
});

/** The uploader presenting this `Authorization` header, or Unauthenticated. */
export const authenticateUploader = Effect.fn("Ingest.authenticate")(function* (
  authorization: string | undefined,
) {
  const token = authorization?.trim().match(BEARER)?.[1];
  if (token === undefined) return yield* new Unauthenticated();
  const store = yield* UploaderStore;
  const principal = yield* store.authenticate(yield* digest(token), yield* nowIso);
  if (Option.isNone(principal)) return yield* new Unauthenticated();
  return principal.value;
});

export const listUploaders = Effect.fn("Ingest.listUploaders")(function* () {
  const owner = yield* authorize();
  const store = yield* UploaderStore;
  return yield* store.list(owner);
});

export const revokeUploader = Effect.fn("Ingest.revokeUploader")(function* (input: unknown) {
  const owner = yield* authorize();
  const id = yield* Schema.decodeUnknownEffect(Schema.Struct({ id: UploaderId }))(input).pipe(
    Effect.mapError(() => new InvalidUploaderInput()),
  );
  const store = yield* UploaderStore;
  return yield* store.revoke(owner, id.id, yield* nowIso);
});

export const recentSessions = Effect.fn("Ingest.recentSessions")(function* () {
  const owner = yield* authorize();
  const store = yield* SessionStore;
  return yield* store.recent(owner);
});

// --- Transcript entries ----------------------------------------------------------

const fields = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const text = (value: unknown) =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const items = (value: unknown) => (Array.isArray(value) ? value.map(fields) : []);

/**
 * Stable key of a transcript line within its file: the harness's own entry ID when
 * it has one (so a rewritten file dedups), otherwise the line's byte offset.
 */
export const entryKey = (harness: Harness, raw: unknown, offset: number): string => {
  const entry = fields(raw);
  const key =
    harness === "claude-code"
      ? text(entry?.uuid)
      : isPiFamily(harness)
        ? text(entry?.id)
        : typeof entry?.ordinal === "number" && Number.isSafeInteger(entry.ordinal)
          ? `#${entry.ordinal}`
          : undefined;
  return key ?? `@${offset}`;
};

/** `type`, refined by Codex's payload type or pi's message role. */
export const entryEvent = (harness: Harness, raw: unknown): string => {
  const entry = fields(raw);
  const type = text(entry?.type) ?? "entry";
  const detail =
    harness === "codex"
      ? text(fields(entry?.payload)?.type)
      : isPiFamily(harness)
        ? text(fields(entry?.message)?.role)
        : undefined;
  return detail ? `${type}/${detail}` : type;
};

/** Tool names called or answered in this entry, for the search projection. */
export const entryTools = (harness: Harness, raw: unknown): ReadonlyArray<string> => {
  const entry = fields(raw);
  const names: Array<string | undefined> = [];
  if (harness === "codex") {
    names.push(text(fields(entry?.payload)?.name));
  } else {
    const message = fields(entry?.message);
    for (const item of items(message?.content)) {
      if (item?.type === "tool_use" || item?.type === "toolCall") names.push(text(item.name));
    }
    if (isPiFamily(harness)) names.push(text(message?.toolName));
  }
  return [...new Set(names.filter((name) => name !== undefined))];
};

const occurredAt = (raw: unknown, fallback: string) => {
  const timestamp = text(fields(raw)?.timestamp);
  return timestamp !== undefined && !Number.isNaN(Date.parse(timestamp)) ? timestamp : fallback;
};

const utf8Length = (value: string) => new TextEncoder().encode(value).length;

/** Maps one transcript line to a trace. The raw line is stored unchanged. */
export const entryTrace = (
  owner: Owner,
  batch: IngestBatch,
  entry: IngestBatch["entries"][number],
  receivedAt: string,
): Trace => {
  const { harness } = batch.client;
  const { id: sessionId, stream } = batch.session;
  const event = entryEvent(harness, entry.raw);
  const tools = entryTools(harness, entry.raw);
  // A secondary stream (a subagent transcript) is qualified by its session, so its
  // offset-keyed entries can't collide with another session's.
  const scope = stream === sessionId ? stream : `${sessionId}/${stream}`;
  return {
    owner,
    id: EventId.make(`${harness}:${scope}:${entryKey(harness, entry.raw, entry.offset)}`),
    source: harness,
    sessionId: SessionId.make(batch.session.id),
    event: EventName.make(event),
    occurredAt: occurredAt(entry.raw, receivedAt),
    summary: tools.length > 0 ? tools.join(", ") : event,
    raw: entry.raw,
  };
};

/**
 * Stores one incremental slice of a session transcript. Authenticates the bearer
 * token before reading the body. Entries are written first, then the session's
 * provenance; both are idempotent, so the uploader retries the whole slice on any
 * failure. Spans carry the harness and counts only.
 */
export const ingestBatch = Effect.fn("Ingest.batch")(function* (
  authorization: string | undefined,
  body: Effect.Effect<unknown, InvalidIngestBatch | TraceEventTooLarge>,
) {
  const uploader = yield* authenticateUploader(authorization);
  const batch = yield* Schema.decodeUnknownEffect(IngestBatch)(yield* body).pipe(
    Effect.mapError(() => new InvalidIngestBatch()),
  );
  let total = 0;
  for (const entry of batch.entries) {
    const length = utf8Length(JSON.stringify(entry.raw));
    if (length > MAX_ENTRY_BYTES)
      return yield* new TraceEventTooLarge({ length, limit: MAX_ENTRY_BYTES });
    total += length;
  }
  if (total > MAX_BATCH_BYTES)
    return yield* new TraceEventTooLarge({ length: total, limit: MAX_BATCH_BYTES });
  const receivedAt = yield* nowIso;
  const traces = batch.entries.map((entry) => entryTrace(uploader.owner, batch, entry, receivedAt));
  const inserted = yield* (yield* TraceStore).insertMany(traces);
  const sessions = yield* SessionStore;
  yield* sessions.record({
    owner: uploader.owner,
    source: batch.client.harness,
    sessionId: SessionId.make(batch.session.id),
    harnessVersion: batch.client.harnessVersion,
    uploaderVersion: batch.client.uploaderVersion,
    uploaderId: uploader.id,
    host: batch.client.host,
    platform: batch.client.platform,
    cwd: batch.session.cwd,
    inserted,
    at: receivedAt,
  });
  yield* Effect.annotateCurrentSpan({
    "traces.source": batch.client.harness,
    "traces.received": traces.length,
    "traces.inserted": inserted,
  });
  return { received: traces.length, inserted };
});
