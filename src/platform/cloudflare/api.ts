import * as Cloudflare from "alchemy/Cloudflare";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as Layer from "effect/Layer";
import { InstallAddress } from "../../install.ts";
import { AppInfo } from "../../service.ts";
import { apiRoutes } from "../../api.ts";
import { Database, identity, storage } from "./traces.ts";

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
    observability: {
      enabled: true,
      logs: { enabled: true, invocationLogs: true, headSamplingRate: 1, persist: true },
    },
  },
  Effect.gen(function* () {
    const db = yield* Cloudflare.D1.QueryDatabase(yield* Database);
    const runtime = yield* Alchemy.RuntimeContext;
    const context = yield* Cloudflare.WorkerExecutionContext;
    const url = yield* Cloudflare.Worker.URL;
    const services = Layer.mergeAll(
      storage(db, runtime),
      identity(context, runtime),
      Layer.succeed(InstallAddress, {
        apiUrl: url.pipe(Effect.provideService(Alchemy.RuntimeContext, runtime)),
      }),
      AppInfo.layer("Traces"),
    );
    const handler = yield* HttpRouter.toHttpEffect(apiRoutes);
    return {
      fetch: handler.pipe(Effect.provide(services), Effect.withSpan("Api.request")),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Cloudflare.D1.QueryDatabaseBinding,
        Cloudflare.Telemetry({ headSamplingRate: 1, persist: true }),
        Alchemy.RuntimeContext.phantom,
      ),
    ),
  ),
) {}
