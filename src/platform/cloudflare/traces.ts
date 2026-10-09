import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { Identity, Trace, TraceStore } from "../../traces.ts";

export const Database = Cloudflare.D1.Database("Traces", { migrations: "migrations" });

export const storage = (
  db: Cloudflare.D1.QueryDatabaseClient,
  runtime: Alchemy.BaseRuntimeContext,
) =>
  Layer.succeed(TraceStore, {
    insert: (trace) =>
      Effect.map(
        db
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
        (result) => result.meta.changes > 0,
      ).pipe(Effect.provideService(Alchemy.RuntimeContext, runtime)),
    search: (owner, query) =>
      Effect.gen(function* () {
        const result = yield* db
          .prepare(
            "SELECT owner, id, source, session_id, event, occurred_at, summary, raw FROM events WHERE owner = ? AND (session_id = ? OR summary LIKE ? ESCAPE '\\') ORDER BY occurred_at DESC, id DESC LIMIT 100",
          )
          .bind(owner, query, `%${query.replace(/[\\%_]/g, "\\$&")}%`)
          .all<{
            owner: string;
            id: string;
            source: string;
            session_id: string;
            event: string;
            occurred_at: string;
            summary: string;
            raw: string;
          }>();
        return yield* Effect.forEach(result.results, (row) =>
          Schema.decodeUnknownEffect(Trace)({
            ...row,
            sessionId: row.session_id,
            occurredAt: row.occurred_at,
            raw: JSON.parse(String(row.raw)),
          }),
        );
      }).pipe(Effect.orDie, Effect.provideService(Alchemy.RuntimeContext, runtime)),
  });

export const identity = (
  context: Cloudflare.WorkerExecutionContext["Service"],
  runtime: Alchemy.BaseRuntimeContext,
) =>
  Layer.succeed(Identity, {
    owner: Effect.gen(function* () {
      const access = yield* context.access;
      if (!access) return null;
      // Access may not expose a user identity for service-token authentication.
      // The authenticated Access context is only present after the policy admits the request.
      return "owner";
    }).pipe(Effect.provideService(Alchemy.RuntimeContext, runtime)),
  });
