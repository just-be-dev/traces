import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { InstallAddress, installInstructions } from "./install.ts";
import { AppInfo } from "./service.ts";
import { Identity, normalize, Submission, TraceStore } from "./traces.ts";

const json = (body: unknown, status = 200) =>
  HttpServerResponse.jsonUnsafe(body, {
    status,
    headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });

const Rpc = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: Schema.Union([Schema.String, Schema.Finite]),
  method: Schema.String,
  params: Schema.optional(Schema.Unknown),
});

const Search = Schema.Struct({ query: Schema.String });
const install = Effect.gen(function* () {
  const address = yield* InstallAddress;
  return installInstructions(yield* address.apiUrl);
});

const authorize = Effect.gen(function* () {
  const identity = yield* Identity;
  return yield* identity.owner;
});

const search = (owner: string, query: string) =>
  Effect.gen(function* () {
    const store = yield* TraceStore;
    return yield* store.search(owner, query);
  });

export const apiRoutes = Layer.mergeAll(
  HttpRouter.add(
    "GET",
    "/install",
    Effect.gen(function* () {
      return HttpServerResponse.text(yield* install, {
        headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": "no-store" },
      });
    }),
  ),
  HttpRouter.add(
    "GET",
    "/api/health",
    Effect.gen(function* () {
      const info = yield* AppInfo;
      return json(yield* info.read);
    }),
  ),
  HttpRouter.add(
    "POST",
    "/api/events",
    Effect.gen(function* () {
      const owner = yield* authorize;
      if (!owner) return json({ error: "Unauthorized" }, 401);
      const request = yield* HttpServerRequest.HttpServerRequest;
      const input = yield* Schema.decodeUnknownEffect(Submission)(yield* request.json).pipe(
        Effect.option,
      );
      if (input._tag === "None") return json({ error: "Invalid trace event" }, 400);
      if (JSON.stringify(input.value.raw).length > 64_000)
        return json({ error: "Trace event exceeds 64 KB" }, 413);
      const store = yield* TraceStore;
      const inserted = yield* store.insert(normalize(owner, input.value));
      return json({ inserted }, inserted ? 201 : 200);
    }),
  ),
  HttpRouter.add(
    "GET",
    "/api/events",
    Effect.gen(function* () {
      const owner = yield* authorize;
      if (!owner) return json({ error: "Unauthorized" }, 401);
      const request = yield* HttpServerRequest.HttpServerRequest;
      const query = new URL(request.url, "http://local").searchParams.get("q") ?? "";
      if (!query || query.length > 200) return json({ error: "q must be 1–200 characters" }, 400);
      return json({ events: yield* search(owner, query) });
    }),
  ),
  HttpRouter.add(
    "POST",
    "/mcp",
    Effect.gen(function* () {
      const owner = yield* authorize;
      if (!owner) return json({ error: "Unauthorized" }, 401);
      const request = yield* HttpServerRequest.HttpServerRequest;
      const body = yield* request.json;
      const notification = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ jsonrpc: Schema.Literal("2.0"), method: Schema.String }),
      )(body).pipe(Effect.option);
      if (notification._tag === "Some" && notification.value.method === "notifications/initialized")
        return HttpServerResponse.empty({ status: 202 });
      const input = yield* Schema.decodeUnknownEffect(Rpc)(body).pipe(Effect.option);
      if (input._tag === "None")
        return json(
          { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } },
          400,
        );
      const { id, method, params } = input.value;
      let result: unknown;
      if (method === "initialize")
        result = {
          protocolVersion: "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "traces", version: "0.1.0" },
        };
      else if (method === "tools/list")
        result = {
          tools: [
            {
              name: "search_traces",
              description: "Find recent trace events by session ID or tool name.",
              inputSchema: {
                type: "object",
                properties: { query: { type: "string" } },
                required: ["query"],
              },
            },
            {
              name: "inspect_hooks",
              description:
                "Read setup instructions for remote MCP and opt-in agent hooks; never changes files.",
              inputSchema: { type: "object", properties: {} },
            },
          ],
        };
      else if (method === "tools/call") {
        const call = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ name: Schema.String, arguments: Schema.optional(Schema.Unknown) }),
        )(params).pipe(Effect.option);
        if (call._tag === "None")
          return json({
            jsonrpc: "2.0",
            id,
            error: { code: -32602, message: "Invalid parameters" },
          });
        if (call.value.name === "inspect_hooks")
          result = { content: [{ type: "text", text: yield* install }] };
        else if (call.value.name === "search_traces") {
          const args = yield* Schema.decodeUnknownEffect(Search)(call.value.arguments).pipe(
            Effect.option,
          );
          if (args._tag === "None" || !args.value.query || args.value.query.length > 200)
            return json({ jsonrpc: "2.0", id, error: { code: -32602, message: "Invalid query" } });
          result = {
            content: [
              { type: "text", text: JSON.stringify(yield* search(owner, args.value.query)) },
            ],
          };
        } else
          return json({ jsonrpc: "2.0", id, error: { code: -32601, message: "Unknown tool" } });
      } else
        return json({ jsonrpc: "2.0", id, error: { code: -32601, message: "Unknown method" } });
      return json({ jsonrpc: "2.0", id, result });
    }),
  ),
  HttpRouter.add("*", "*", json({ error: "Not found" }, 404)),
);
