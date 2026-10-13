import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { SessionStore, UploaderId, UploaderStore } from "../../ingest.ts";
import { Owner, SessionId } from "../../traces.ts";
import { sqliteD1 } from "./d1.testing.ts";
import { sessions, uploaders } from "./ingest.ts";

const owner = Owner.make("owner");
const id = UploaderId.make("upl_0123456789abcdef");

test("uploader claims are single-use, expire, and stop authenticating once revoked", async () => {
  const { d1, db } = await sqliteD1();
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* UploaderStore;
      yield* store.create({
        owner,
        id,
        label: "laptop",
        harness: "codex",
        claimHash: "claim",
        claimExpiresAt: "2026-10-09T12:10:00.000Z",
        createdAt: "2026-10-09T12:00:00.000Z",
      });
      const expired = yield* store.claim("claim", "token", "2026-10-09T12:10:00.000Z");
      const claimed = yield* store.claim("claim", "token", "2026-10-09T12:01:00.000Z");
      const again = yield* store.claim("claim", "other", "2026-10-09T12:02:00.000Z");
      const authenticated = yield* store.authenticate("token", "2026-10-09T12:03:00.000Z");
      const wrong = yield* store.authenticate("other", "2026-10-09T12:03:00.000Z");
      const listed = yield* store.list(owner);
      const othersRevoke = yield* store.revoke(Owner.make("other"), id, "2026-10-09T12:04:00.000Z");
      const revoked = yield* store.revoke(owner, id, "2026-10-09T12:05:00.000Z");
      const afterRevoke = yield* store.authenticate("token", "2026-10-09T12:06:00.000Z");
      return {
        expired,
        claimed,
        again,
        authenticated,
        wrong,
        listed,
        othersRevoke,
        revoked,
        afterRevoke,
      };
    }).pipe(Effect.provide(uploaders(Effect.succeed(d1)))),
  );
  const principal = Option.some({ owner, id });
  expect(result).toEqual({
    expired: Option.none(),
    claimed: principal,
    again: Option.none(),
    authenticated: principal,
    wrong: Option.none(),
    listed: [
      {
        id,
        label: "laptop",
        harness: "codex",
        createdAt: "2026-10-09T12:00:00.000Z",
        claimedAt: "2026-10-09T12:01:00.000Z",
        lastUsedAt: "2026-10-09T12:03:00.000Z",
      },
    ],
    othersRevoke: false,
    revoked: true,
    afterRevoke: Option.none(),
  });
  // Only digests are stored, and the used claim digest is gone.
  expect(db.query("SELECT claim_hash, token_hash FROM uploaders").all()).toEqual([
    { claim_hash: null, token_hash: "token" },
  ]);
});

test("session provenance upserts, keeps known optional fields, and adds entry counts", async () => {
  const { d1 } = await sqliteD1();
  const upload = {
    owner,
    source: "claude-code" as const,
    sessionId: SessionId.make("session-1"),
    harnessVersion: "2.1.0",
    uploaderVersion: "0.1.0",
    uploaderId: id,
    host: "laptop",
    platform: "darwin-arm64",
    cwd: "/work",
    inserted: 3,
    at: "2026-10-09T12:00:00.000Z",
  };
  const recent = await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* SessionStore;
      yield* store.record(upload);
      yield* store.record({
        ...upload,
        harnessVersion: undefined,
        cwd: undefined,
        inserted: 2,
        at: "2026-10-09T12:05:00.000Z",
      });
      yield* store.record({ ...upload, owner: Owner.make("other") });
      return yield* store.recent(owner);
    }).pipe(Effect.provide(Layer.mergeAll(sessions(Effect.succeed(d1))))),
  );
  expect(recent).toEqual([
    {
      source: "claude-code",
      sessionId: SessionId.make("session-1"),
      harnessVersion: "2.1.0",
      uploaderVersion: "0.1.0",
      uploaderId: id,
      host: "laptop",
      platform: "darwin-arm64",
      cwd: "/work",
      entries: 5,
      firstUploadedAt: "2026-10-09T12:00:00.000Z",
      lastUploadedAt: "2026-10-09T12:05:00.000Z",
    },
  ]);
});
