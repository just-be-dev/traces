import * as Cloudflare from "alchemy/Cloudflare";
import * as Alchemy from "alchemy";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { InstallAddress } from "../../install/guide.ts";
import { AppInfo } from "../../service.ts";
import { apiRoutes, traceRequest } from "../../api.ts";
import { indexPendingTraces } from "../../traces.ts";
import { recordPendingUsage, refreshUsageStats, Showcase, TimeZone } from "../../usage.ts";
import { sessions, uploaders } from "./ingest.ts";
import { apiRoutes as accessRoutes } from "./domain.ts";
import { ContentSearch, contentIndex } from "./search.ts";
import { Database, identity, singleOwner, storage } from "./traces.ts";
import { usage } from "./usage.ts";

// Prototype volume: keep every request. Lower both rates together once traffic grows.
const sampling = { headSamplingRate: 1, persist: true } as const;

/** Workers Observability for both Workers: invocation logs plus traces. */
export const observability = {
  enabled: true,
  logs: { enabled: true, invocationLogs: true, ...sampling },
  traces: { enabled: true, ...sampling },
};

/**
 * Non-local redirect URIs that dynamically registered MCP clients may use. Local
 * clients (Claude Code, Codex, pi, local Executor) call back on localhost or
 * loopback and need no entry. Hosted clients must be listed exactly, or Access
 * rejects sign-in with "Redirect URI not allowed by application configuration".
 * Add more, e.g. a self-hosted Executor's `<origin>/oauth/callback`, with
 * comma-separated `TRACES_OAUTH_REDIRECT_URIS`.
 */
const oauthRedirectUris = [
  // Hosted Executor (https://executor.sh) mounts its API, and the callback, under /api.
  "https://executor.sh/api/oauth/callback",
  ...(process.env.TRACES_OAUTH_REDIRECT_URIS ?? "")
    .split(",")
    .map((uri) => uri.trim())
    .filter((uri) => uri !== ""),
];

/**
 * Members of the Cloudflare account the stack deploys to, signed in with the Cloudflare login (the
 * only sign-in that proves membership), plus an optional service token for other noninteractive
 * clients. A plan-time lookup: it resolves during deploy, never in the running Worker.
 */
const cloudflareLogin = Cloudflare.Access.getIdentityProvider({ type: "cloudflare" });

const Access = Cloudflare.Access.Application("TracesAccess", {
  type: "self_hosted",
  allowedIdps: [cloudflareLogin.identityProviderId.as<string>()],
  policies: [
    {
      decision: "allow",
      include: [
        { cloudflareAccountMember: cloudflareLogin.accountId.as<string>() },
        ...(process.env.TRACES_ACCESS_SERVICE_TOKEN_ID
          ? [{ serviceToken: process.env.TRACES_ACCESS_SERVICE_TOKEN_ID }]
          : []),
      ],
    },
  ],
  oauthConfiguration: {
    enabled: true,
    dynamicClientRegistration: {
      enabled: true,
      allowedUris: oauthRedirectUris,
      allowAnyOnLocalhost: true,
      allowAnyOnLoopback: true,
    },
  },
});

export default class Api extends Cloudflare.Worker<Api>()(
  "Api",
  {
    main: import.meta.url,
    access: Access,
    routes: accessRoutes,
    dev: { access: { aud: "local", identity: { email: "local@example.invalid" } } },
    compatibility: { date: "2026-10-04" },
    observability,
  },
  Effect.gen(function* () {
    const db = yield* Cloudflare.D1.QueryDatabase(yield* Database);
    // AI Search has no local emulation: `alchemy dev` creates a real instance and proxies to it.
    const contents = yield* Cloudflare.AI.QuerySearch(yield* ContentSearch);
    const runtime = yield* Alchemy.RuntimeContext;
    const context = yield* Cloudflare.WorkerExecutionContext;
    const url = yield* Cloudflare.Worker.URL;
    // Bound at deploy from the same TRACES_DOMAIN as the routes; empty in dev. On the
    // public domain, MCP is served at https://<domain>/mcp through an API route.
    const domain = yield* Config.String("TRACES_DOMAIN").pipe(Config.withDefault(""));
    const publicUrl = domain ? `https://${domain}` : undefined;
    // The homepage's days fall in the owner's zone, not each visitor's. An unknown
    // zone fails the deploy rather than silently showing UTC days.
    const timeZone = yield* Config.schema(TimeZone, "TRACES_TIMEZONE").pipe(
      Config.withDefault(TimeZone.make("UTC")),
    );
    const withRuntime = Effect.provideService(Alchemy.RuntimeContext, runtime);
    const d1 = db.raw.pipe(withRuntime);
    const services = Layer.mergeAll(
      storage(d1),
      usage(d1),
      uploaders(d1),
      sessions(d1),
      contentIndex(contents.raw.pipe(withRuntime)),
      identity(context.access.pipe(withRuntime)),
      Layer.succeed(InstallAddress, {
        apiUrl: publicUrl ? Effect.succeed(publicUrl) : url.pipe(withRuntime),
        publicOrigin: Option.fromNullishOr(publicUrl),
      }),
      AppInfo.layer("Traces"),
      Layer.succeed(Showcase, { owner: singleOwner, timeZone }),
    );
    // Two independent sweeps; one failing doesn't stop the other.
    // The content index sweep backfills traces stored before content search existed
    // and retries failed uploads. The usage sweep projects LLM usage from new traces.
    yield* Cloudflare.Workers.cron("* * * * *", () =>
      Effect.all(
        [
          indexPendingTraces().pipe(
            Effect.catch((error) =>
              Effect.logError("Content index sweep failed", error.cause).pipe(
                Effect.annotateLogs({ "traces.operation": error.operation }),
              ),
            ),
          ),
          // Refreshing right after the sweep picks up what it just recorded.
          recordPendingUsage().pipe(
            Effect.andThen(refreshUsageStats()),
            Effect.catch((error) =>
              Effect.logError("Usage sweep or stats refresh failed", error.cause).pipe(
                Effect.annotateLogs({ "traces.operation": error.operation }),
              ),
            ),
          ),
        ],
        { concurrency: "unbounded", discard: true },
      ).pipe(Effect.provide(services)),
    );
    const handler = yield* HttpRouter.toHttpEffect(apiRoutes);
    return {
      fetch: traceRequest(handler).pipe(Effect.provide(services)),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Cloudflare.D1.QueryDatabaseBinding,
        Cloudflare.AI.QuerySearchBinding,
        Cloudflare.Workers.CronEventSourceLive,
        // Mirrors Effect.fn and Effect.withSpan spans into the Workers trace waterfall.
        Cloudflare.Telemetry(sampling),
        Alchemy.RuntimeContext.phantom,
      ),
    ),
  ),
) {}
