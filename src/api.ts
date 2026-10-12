import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { readInstallInstructions } from "./install.ts";
import { AppInfo } from "./service.ts";
import {
  authorize,
  InvalidSearchQuery,
  InvalidTraceEvent,
  MAX_CONTENT_RESULTS,
  MAX_QUERY_LENGTH,
  searchTraceContents,
  searchTraces,
  submitTrace,
  type TraceEventTooLarge,
  type TraceIndexError,
  type TraceStoreError,
  type Unauthenticated,
} from "./traces.ts";

const json = (body: unknown, status = 200) =>
  HttpServerResponse.jsonUnsafe(body, {
    status,
    headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });

/**
 * Root server span for one API request. Records method, path, matched route
 * (added by the router), and status. Never the query string, headers, or body.
 */
export const traceRequest = Effect.fn("Api.request", { kind: "server" })(function* <E, R>(
  handler: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  yield* Effect.annotateCurrentSpan({
    "http.request.method": request.method,
    "url.path": new URL(request.url, "http://local").pathname,
  });
  const response = yield* handler;
  yield* Effect.annotateCurrentSpan("http.response.status_code", response.status);
  return response;
});

// Storage causes are adapter errors (SQL and driver messages), not payloads.
const logStoreFailure = (error: TraceStoreError) =>
  Effect.logError("Trace storage failed", error.cause).pipe(
    Effect.annotateLogs({ "traces.operation": error.operation }),
  );

// Search-service causes are binding errors, not queries or document text.
const logIndexFailure = (error: TraceIndexError) =>
  Effect.logError("Trace content search failed", error.cause).pipe(
    Effect.annotateLogs({ "traces.operation": error.operation }),
  );

const httpFailure = (
  error:
    | Unauthenticated
    | InvalidTraceEvent
    | TraceEventTooLarge
    | InvalidSearchQuery
    | TraceStoreError
    | TraceIndexError,
) => {
  switch (error._tag) {
    case "Unauthenticated":
      return Effect.succeed(json({ error: "Unauthorized" }, 401));
    case "InvalidTraceEvent":
      return Effect.succeed(json({ error: "Invalid trace event" }, 400));
    case "TraceEventTooLarge":
      return Effect.succeed(json({ error: "Trace event exceeds 64 KB" }, 413));
    case "InvalidSearchQuery":
      return Effect.succeed(json({ error: `q must be 1–${MAX_QUERY_LENGTH} characters` }, 400));
    case "TraceStoreError":
      return logStoreFailure(error).pipe(
        Effect.as(json({ error: "Trace storage unavailable" }, 503)),
      );
    case "TraceIndexError":
      return logIndexFailure(error).pipe(
        Effect.as(json({ error: "Trace content search unavailable" }, 503)),
      );
  }
};

const JsonRpcNotification = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  method: Schema.String,
});
const JsonRpcRequest = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: Schema.Union([Schema.String, Schema.Finite]),
  method: Schema.String,
  params: Schema.optional(Schema.Unknown),
});
const ToolCall = Schema.Struct({ name: Schema.String, arguments: Schema.optional(Schema.Unknown) });
const SearchArguments = Schema.Struct({ query: Schema.String });

class JsonRpcError extends Schema.TaggedError<JsonRpcError>()("JsonRpcError", {
  code: Schema.Int,
  message: Schema.String,
}) {}

const tools = [
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
    name: "search_trace_contents",
    description: `Full-text search over trace payloads: prompts, tool inputs, and tool results. Every whitespace-separated term must appear; terms match substrings, case-insensitively, and should be at least 3 characters. Best match first, at most ${MAX_CONTENT_RESULTS}. A new event can take a minute or two to become searchable.`,
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
];

const callTool = Effect.fn("Mcp.callTool")(function* (params: unknown) {
  const call = yield* Schema.decodeUnknownEffect(ToolCall)(params).pipe(
    Effect.mapError(() => new JsonRpcError({ code: -32602, message: "Invalid parameters" })),
  );
  switch (call.name) {
    case "inspect_hooks": {
      yield* Effect.annotateCurrentSpan("mcp.tool", call.name);
      return { content: [{ type: "text", text: yield* readInstallInstructions() }] };
    }
    case "search_traces": {
      yield* Effect.annotateCurrentSpan("mcp.tool", call.name);
      const args = yield* Schema.decodeUnknownEffect(SearchArguments)(call.arguments).pipe(
        Effect.mapError(() => new InvalidSearchQuery()),
      );
      const traces = yield* searchTraces(args.query);
      return { content: [{ type: "text", text: JSON.stringify(traces) }] };
    }
    case "search_trace_contents": {
      yield* Effect.annotateCurrentSpan("mcp.tool", call.name);
      const args = yield* Schema.decodeUnknownEffect(SearchArguments)(call.arguments).pipe(
        Effect.mapError(() => new InvalidSearchQuery()),
      );
      const traces = yield* searchTraceContents(args.query);
      return { content: [{ type: "text", text: JSON.stringify(traces) }] };
    }
    default:
      return yield* new JsonRpcError({ code: -32601, message: "Unknown tool" });
  }
});

const dispatch = Effect.fn("Mcp.dispatch")(function* (method: string, params: unknown) {
  switch (method) {
    case "initialize":
      yield* Effect.annotateCurrentSpan("mcp.method", method);
      return {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "traces", version: "0.1.0" },
      };
    case "tools/list":
      yield* Effect.annotateCurrentSpan("mcp.method", method);
      return { tools };
    case "tools/call":
      yield* Effect.annotateCurrentSpan("mcp.method", method);
      return yield* callTool(params);
    default:
      return yield* new JsonRpcError({ code: -32601, message: "Unknown method" });
  }
});

const mcp = Effect.gen(function* () {
  // Every MCP method, including discovery, requires an Access identity.
  yield* authorize();
  const request = yield* HttpServerRequest.HttpServerRequest;
  const body = yield* request.json.pipe(Effect.option);
  if (body._tag === "None")
    return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
  const notification = Schema.decodeUnknownOption(JsonRpcNotification)(body.value);
  if (notification._tag === "Some" && notification.value.method === "notifications/initialized")
    return HttpServerResponse.empty({ status: 202 });
  const rpc = Schema.decodeUnknownOption(JsonRpcRequest)(body.value);
  if (rpc._tag === "None")
    return json(
      { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } },
      400,
    );
  const { id, method, params } = rpc.value;
  const failure = (code: number, message: string) =>
    json({ jsonrpc: "2.0", id, error: { code, message } });
  return yield* dispatch(method, params).pipe(
    Effect.map((result) => json({ jsonrpc: "2.0", id, result })),
    Effect.catchTags({
      JsonRpcError: (error) => Effect.succeed(failure(error.code, error.message)),
      InvalidSearchQuery: () => Effect.succeed(failure(-32602, "Invalid query")),
      TraceStoreError: (error) =>
        logStoreFailure(error).pipe(Effect.as(failure(-32603, "Trace storage unavailable"))),
      TraceIndexError: (error) =>
        logIndexFailure(error).pipe(Effect.as(failure(-32603, "Trace content search unavailable"))),
    }),
  );
});

export const apiRoutes = Layer.mergeAll(
  HttpRouter.add(
    "GET",
    "/install",
    Effect.gen(function* () {
      return HttpServerResponse.text(yield* readInstallInstructions(), {
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
      const request = yield* HttpServerRequest.HttpServerRequest;
      const inserted = yield* submitTrace(
        request.json.pipe(Effect.mapError(() => new InvalidTraceEvent())),
      );
      return json({ inserted }, inserted ? 201 : 200);
    }).pipe(Effect.catch(httpFailure)),
  ),
  HttpRouter.add(
    "GET",
    "/api/events",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const query = new URL(request.url, "http://local").searchParams.get("q") ?? "";
      return json({ events: yield* searchTraces(query) });
    }).pipe(Effect.catch(httpFailure)),
  ),
  HttpRouter.add(
    "GET",
    "/api/search",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const query = new URL(request.url, "http://local").searchParams.get("q") ?? "";
      return json({ events: yield* searchTraceContents(query) });
    }).pipe(Effect.catch(httpFailure)),
  ),
  HttpRouter.add("POST", "/mcp", mcp.pipe(Effect.catch(httpFailure))),
  HttpRouter.add("*", "*", json({ error: "Not found" }, 404)),
);
