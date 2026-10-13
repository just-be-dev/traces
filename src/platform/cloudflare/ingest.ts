import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  Harness,
  IngestStoreError,
  MAX_RECENT_SESSIONS,
  SessionRecord,
  SessionStore,
  Uploader,
  UploaderId,
  UploaderStore,
} from "../../ingest.ts";
import { Owner } from "../../traces.ts";
import type { D1Statements } from "./traces.ts";

// Tables from migrations/0003_ingest.sql.

const nullable = <S extends Schema.Top>(schema: S) => Schema.NullOr(schema);

const StoredUploader = Schema.Struct({
  id: UploaderId,
  label: Schema.String,
  harness: Harness,
  created_at: Schema.String,
  claimed_at: nullable(Schema.String),
  last_used_at: nullable(Schema.String),
  revoked_at: nullable(Schema.String),
});

const Principal = Schema.Struct({ owner: Owner, id: UploaderId });

const StoredSession = Schema.Struct({
  source: Harness,
  session_id: Schema.String,
  harness_version: nullable(Schema.String),
  uploader_version: Schema.String,
  uploader_id: Schema.String,
  host: nullable(Schema.String),
  platform: nullable(Schema.String),
  cwd: nullable(Schema.String),
  entries: Schema.Number,
  first_uploaded_at: Schema.String,
  last_uploaded_at: Schema.String,
});

const present = <K extends string>(key: K, value: string | null) =>
  (value === null ? {} : { [key]: value }) as Partial<Record<K, string>>;

const query = <A>(
  operation: IngestStoreError["operation"],
  run: () => Promise<A>,
): Effect.Effect<A, IngestStoreError> =>
  Effect.tryPromise({ try: run, catch: (cause) => new IngestStoreError({ operation, cause }) });

/** A row that no longer decodes is an adapter failure; its values never reach the error. */
const decodeRows = <S extends Schema.Top & { readonly DecodingServices: never }>(
  operation: IngestStoreError["operation"],
  schema: S,
  rows: ReadonlyArray<unknown>,
) =>
  Schema.decodeUnknownEffect(Schema.Array(schema))(rows).pipe(
    Effect.mapError(
      () =>
        new IngestStoreError({
          operation,
          cause: new Error("Stored row no longer decodes"),
        }),
    ),
  );

const firstPrincipal = (operation: IngestStoreError["operation"], rows: ReadonlyArray<unknown>) =>
  decodeRows(operation, Principal, rows).pipe(
    Effect.map((principals) => Option.fromNullishOr(principals[0])),
  );

export const uploaders = (raw: Effect.Effect<D1Statements>) =>
  Layer.succeed(UploaderStore, {
    create: Effect.fn("UploaderStore.create")(function* (uploader) {
      const d1 = yield* raw;
      yield* query("createUploader", () =>
        d1
          .prepare(
            "INSERT INTO uploaders (id, owner, label, harness, created_at, claim_hash, claim_expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          )
          .bind(
            uploader.id,
            uploader.owner,
            uploader.label,
            uploader.harness,
            uploader.createdAt,
            uploader.claimHash,
            uploader.claimExpiresAt,
          )
          .run(),
      );
    }),
    // One statement, so two concurrent claims of the same code can't both succeed.
    claim: Effect.fn("UploaderStore.claim")(function* (claimHash, tokenHash, now) {
      const d1 = yield* raw;
      const result = yield* query("claimUploader", () =>
        d1
          .prepare(
            "UPDATE uploaders SET token_hash = ?, claim_hash = NULL, claimed_at = ? WHERE claim_hash = ? AND token_hash IS NULL AND revoked_at IS NULL AND claim_expires_at > ? RETURNING owner, id",
          )
          .bind(tokenHash, now, claimHash, now)
          .all(),
      );
      return yield* firstPrincipal("claimUploader", result.results);
    }),
    authenticate: Effect.fn("UploaderStore.authenticate")(function* (tokenHash, now) {
      const d1 = yield* raw;
      const result = yield* query("authenticateUploader", () =>
        d1
          .prepare(
            "UPDATE uploaders SET last_used_at = ? WHERE token_hash = ? AND revoked_at IS NULL RETURNING owner, id",
          )
          .bind(now, tokenHash)
          .all(),
      );
      return yield* firstPrincipal("authenticateUploader", result.results);
    }),
    list: Effect.fn("UploaderStore.list")(function* (owner) {
      const d1 = yield* raw;
      const result = yield* query("listUploaders", () =>
        d1
          .prepare(
            "SELECT id, label, harness, created_at, claimed_at, last_used_at, revoked_at FROM uploaders WHERE owner = ? ORDER BY created_at DESC, id DESC LIMIT 100",
          )
          .bind(owner)
          .all(),
      );
      const rows = yield* decodeRows("listUploaders", StoredUploader, result.results);
      return rows.map((row): Uploader => ({
        id: row.id,
        label: row.label,
        harness: row.harness,
        createdAt: row.created_at,
        ...present("claimedAt", row.claimed_at),
        ...present("lastUsedAt", row.last_used_at),
        ...present("revokedAt", row.revoked_at),
      }));
    }),
    revoke: Effect.fn("UploaderStore.revoke")(function* (owner, id, now) {
      const d1 = yield* raw;
      const result = yield* query("revokeUploader", () =>
        d1
          .prepare(
            "UPDATE uploaders SET revoked_at = ?, claim_hash = NULL WHERE owner = ? AND id = ? AND revoked_at IS NULL",
          )
          .bind(now, owner, id)
          .run(),
      );
      return result.meta.changes > 0;
    }),
  });

export const sessions = (raw: Effect.Effect<D1Statements>) =>
  Layer.succeed(SessionStore, {
    // Optional provenance keeps its last known value when an upload omits it.
    record: Effect.fn("SessionStore.record")(function* (upload) {
      const d1 = yield* raw;
      yield* query("recordSession", () =>
        d1
          .prepare(
            `INSERT INTO sessions (owner, source, session_id, harness_version, uploader_version, uploader_id, host, platform, cwd, entries, first_uploaded_at, last_uploaded_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (owner, source, session_id) DO UPDATE SET
               harness_version = COALESCE(excluded.harness_version, harness_version),
               uploader_version = excluded.uploader_version,
               uploader_id = excluded.uploader_id,
               host = COALESCE(excluded.host, host),
               platform = COALESCE(excluded.platform, platform),
               cwd = COALESCE(excluded.cwd, cwd),
               entries = entries + excluded.entries,
               last_uploaded_at = excluded.last_uploaded_at`,
          )
          .bind(
            upload.owner,
            upload.source,
            upload.sessionId,
            upload.harnessVersion ?? null,
            upload.uploaderVersion,
            upload.uploaderId,
            upload.host ?? null,
            upload.platform ?? null,
            upload.cwd ?? null,
            upload.inserted,
            upload.at,
            upload.at,
          )
          .run(),
      );
    }),
    recent: Effect.fn("SessionStore.recent")(function* (owner) {
      const d1 = yield* raw;
      const result = yield* query("recentSessions", () =>
        d1
          .prepare(
            `SELECT source, session_id, harness_version, uploader_version, uploader_id, host, platform, cwd, entries, first_uploaded_at, last_uploaded_at
             FROM sessions WHERE owner = ? ORDER BY last_uploaded_at DESC LIMIT ?`,
          )
          .bind(owner, MAX_RECENT_SESSIONS)
          .all(),
      );
      const rows = yield* decodeRows("recentSessions", StoredSession, result.results);
      return yield* Effect.forEach(rows, (row) =>
        Schema.decodeUnknownEffect(SessionRecord)({
          source: row.source,
          sessionId: row.session_id,
          uploaderVersion: row.uploader_version,
          uploaderId: row.uploader_id,
          entries: row.entries,
          firstUploadedAt: row.first_uploaded_at,
          lastUploadedAt: row.last_uploaded_at,
          ...present("harnessVersion", row.harness_version),
          ...present("host", row.host),
          ...present("platform", row.platform),
          ...present("cwd", row.cwd),
        }).pipe(
          Effect.mapError(
            () =>
              new IngestStoreError({
                operation: "recentSessions",
                cause: new Error("Stored session no longer decodes"),
              }),
          ),
        ),
      );
    }),
  });
