import * as Cloudflare from "alchemy/Cloudflare";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as Layer from "effect/Layer";
import { InstallAddress } from "../../install.ts";
import { AppInfo } from "../../service.ts";
import { apiRoutes, traceRequest } from "../../api.ts";
import { indexPendingTraces } from "../../traces.ts";
import { ContentSearch, contentIndex } from "./search.ts";
import { Database, identity, storage } from "./traces.ts";

// Prototype volume: keep every request. Lower both rates together once traffic grows.
const sampling = { headSamplingRate: 1, persist: true } as const;

/** Workers Observability for both Workers: invocation logs plus traces. */
export const observability = {
  enabled: true,
  logs: { enabled: true, invocationLogs: true, ...sampling },
  traces: { enabled: true, ...sampling },
};

const Access = Cloudflare.Access.Application("TracesAccess", {
  type: "self_hosted",
  policies: [
    {
      decision: "allow",
      include: [
        { email: process.env.TRACES_ACCESS_EMAIL ?? "nobody@example.invalid" },
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
    const withRuntime = Effect.provideService(Alchemy.RuntimeContext, runtime);
    const services = Layer.mergeAll(
      storage(db.raw.pipe(withRuntime)),
      contentIndex(contents.raw.pipe(withRuntime)),
      identity(context.access.pipe(withRuntime)),
      Layer.succeed(InstallAddress, {
        apiUrl: url.pipe(withRuntime),
      }),
      AppInfo.layer("Traces"),
    );
    // Backfills traces stored before content search existed and retries failed uploads.
    yield* Cloudflare.Workers.cron("* * * * *", () =>
      indexPendingTraces().pipe(
        Effect.catch((error) =>
          Effect.logError("Content index sweep failed", error.cause).pipe(
            Effect.annotateLogs({ "traces.operation": error.operation }),
          ),
        ),
        Effect.provide(services),
      ),
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
