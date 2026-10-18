import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  claimUploader,
  createUploader,
  ingestBatch,
  InvalidClaimCode,
  InvalidIngestBatch,
  type IngestStoreError,
  listUploaders,
  MAX_BATCH_BYTES,
  MAX_BATCH_ENTRIES,
  recentSessions,
  revokeUploader,
} from "./ingest.ts";
import { readInstallGuide } from "./install/guide.ts";
import {
  allSkillFiles,
  directoryAtUri,
  fileAtPath,
  fileAtUri,
  SKILL_NAME,
  SKILL_TTL_MS,
  skillEntry,
  skillManifest,
  SKILLS_EXTENSION,
  skillUri,
} from "./install/skill.ts";
import { AppInfo } from "./service.ts";
import { publicUsageStats, type UsageStoreError } from "./usage.ts";
import {
  authorize,
  InvalidSearchQuery,
  InvalidTraceEvent,
  MAX_CONTENT_RESULTS,
  MAX_QUERY_LENGTH,
  searchTraceContents,
  searchTraces,
  submitTrace,
  TraceEventTooLarge,
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

// Ingest-store causes are SQL and driver messages, never tokens or payloads.
const logIngestStoreFailure = (error: IngestStoreError) =>
  Effect.logError("Ingest storage failed", error.cause).pipe(
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
    | TraceIndexError
    | InvalidIngestBatch
    | InvalidClaimCode
    | IngestStoreError
    | UsageStoreError,
) => {
  switch (error._tag) {
    case "UsageStoreError":
      return Effect.logError("Usage storage failed", error.cause).pipe(
        Effect.annotateLogs({ "traces.operation": error.operation }),
        Effect.as(json({ error: "Usage stats unavailable" }, 503)),
      );
    case "Unauthenticated":
      return Effect.succeed(json({ error: "Unauthorized" }, 401));
    case "InvalidTraceEvent":
      return Effect.succeed(json({ error: "Invalid trace event" }, 400));
    case "InvalidIngestBatch":
      return Effect.succeed(
        json({ error: `Invalid ingest batch (1–${MAX_BATCH_ENTRIES} entries)` }, 400),
      );
    case "InvalidClaimCode":
      return Effect.succeed(json({ error: "Invalid or expired claim code" }, 401));
    case "TraceEventTooLarge":
      return Effect.succeed(
        json({ error: `Trace event exceeds ${Math.round(error.limit / 1000)} KB` }, 413),
      );
    case "IngestStoreError":
      return logIngestStoreFailure(error).pipe(
        Effect.as(json({ error: "Ingest storage unavailable" }, 503)),
      );
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
const SkillFileArguments = Schema.Struct({ path: Schema.optional(Schema.String) });
const UriParams = Schema.Struct({ uri: Schema.String });

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
    description: `Read a file of the ${SKILL_NAME} skill, which installs turn-end trace upload hooks for Claude Code, Codex, or pi. Defaults to SKILL.md; pass a relative path such as references/codex.md for the others. Prefer reading the MCP resource ${skillUri("SKILL.md")} when your client supports resources. Never changes files.`,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", enum: allSkillFiles.map((file) => file.path) },
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "create_uploader",
    description:
      "Create an upload credential for this machine's agent harness. Returns a single-use claimCode valid for 10 minutes; exchange it immediately with `traces.ts login --url <ORIGIN> --code <claimCode>` as the install-traces skill describes. Never ask the user for, or print, the resulting token.",
    inputSchema: {
      type: "object",
      properties: {
        harness: { type: "string", enum: ["claude-code", "codex", "pi", "omp"] },
        label: { type: "string", description: "e.g. '<hostname> <harness>'", maxLength: 100 },
      },
      required: ["harness"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: "list_uploaders",
    description:
      "List upload credentials with their harness, creation, claim, last use, and revocation times.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: "revoke_uploader",
    description:
      "Revoke an upload credential by ID. Its token stops working immediately; already uploaded traces are kept.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  {
    name: "list_sessions",
    description:
      "Most recently uploaded sessions with harness, harness version, uploader, host, working directory, entry count, and upload times. Use it to verify that trace upload works.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
];

const callTool = Effect.fn("Mcp.callTool")(function* (params: unknown) {
  const call = yield* Schema.decodeUnknownEffect(ToolCall)(params).pipe(
    Effect.mapError(() => new JsonRpcError({ code: -32602, message: "Invalid parameters" })),
  );
  switch (call.name) {
    case "inspect_hooks": {
      yield* Effect.annotateCurrentSpan("mcp.tool", call.name);
      const args = yield* Schema.decodeUnknownEffect(SkillFileArguments)(call.arguments ?? {}).pipe(
        Effect.mapError(() => new JsonRpcError({ code: -32602, message: "Invalid parameters" })),
      );
      const file = fileAtPath(args.path ?? "SKILL.md");
      if (!file) return yield* new JsonRpcError({ code: -32602, message: "Unknown skill file" });
      return { content: [{ type: "text", text: file.text }] };
    }
    case "create_uploader": {
      yield* Effect.annotateCurrentSpan("mcp.tool", call.name);
      const created = yield* createUploader(call.arguments);
      return { content: [{ type: "text", text: JSON.stringify(created) }] };
    }
    case "list_uploaders": {
      yield* Effect.annotateCurrentSpan("mcp.tool", call.name);
      return { content: [{ type: "text", text: JSON.stringify(yield* listUploaders()) }] };
    }
    case "revoke_uploader": {
      yield* Effect.annotateCurrentSpan("mcp.tool", call.name);
      const revoked = yield* revokeUploader(call.arguments);
      return { content: [{ type: "text", text: JSON.stringify({ revoked }) }] };
    }
    case "list_sessions": {
      yield* Effect.annotateCurrentSpan("mcp.tool", call.name);
      return { content: [{ type: "text", text: JSON.stringify(yield* recentSessions()) }] };
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

const serverInfo = { name: "traces", version: "0.2.0" };
const capabilities = {
  tools: {},
  resources: {},
  extensions: { [SKILLS_EXTENSION]: { directoryRead: true } },
};
const instructions = `Search the user's coding-agent traces. To set up trace uploads from this machine, load the ${SKILL_NAME} skill (${skillUri("SKILL.md")}) by reading it as a resource, or call inspect_hooks if resources aren't available.`;
// Skill results carry the Skills extension's cache fields; content changes only on deploy.
const cached = { resultType: "complete", ttlMs: SKILL_TTL_MS, cacheScope: "public" } as const;

const unknownResource = new JsonRpcError({ code: -32602, message: "Unknown resource" });

const decodeUri = (params: unknown) =>
  Schema.decodeUnknownEffect(UriParams)(params).pipe(
    Effect.mapError(() => new JsonRpcError({ code: -32602, message: "Invalid parameters" })),
  );

const dispatch = Effect.fn("Mcp.dispatch")(function* (method: string, params: unknown) {
  yield* Effect.annotateCurrentSpan("mcp.method", method);
  switch (method) {
    case "initialize":
      return { protocolVersion: "2025-03-26", capabilities, serverInfo, instructions };
    case "server/discover":
      return {
        ...cached,
        supportedVersions: ["2026-07-28", "2025-06-18", "2025-03-26"],
        capabilities,
        instructions,
        _meta: { "io.modelcontextprotocol/serverInfo": serverInfo },
      };
    case "ping":
      return {};
    case "tools/list":
      return { tools };
    case "tools/call":
      return yield* callTool(params);
    case "skills/list":
      return { ...cached, skills: [yield* skillEntry()] };
    case "skills/get": {
      const { uri } = yield* decodeUri(params);
      if (uri !== skillUri("SKILL.md")) return yield* unknownResource;
      return { ...cached, skill: yield* skillEntry() };
    }
    case "resources/list": {
      const manifest = yield* skillManifest();
      return {
        resources: allSkillFiles.map((file, index) => ({
          uri: skillUri(file.path),
          name: `${SKILL_NAME}/${file.path}`,
          mimeType: file.mimeType,
          size: manifest[index]?.size,
          ...(file.path === "SKILL.md"
            ? { description: "Install turn-end trace upload hooks for this agent." }
            : {}),
        })),
      };
    }
    case "resources/templates/list":
      return { resourceTemplates: [] };
    case "resources/read": {
      const { uri } = yield* decodeUri(params);
      const file = fileAtUri(uri);
      if (!file) return yield* unknownResource;
      return { ...cached, contents: [{ uri, mimeType: file.mimeType, text: file.text }] };
    }
    case "resources/directory/read": {
      const { uri } = yield* decodeUri(params);
      const children = directoryAtUri(uri);
      if (!children) return yield* unknownResource;
      return { ...cached, resources: children };
    }
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
      InvalidUploaderInput: () => Effect.succeed(failure(-32602, "Invalid uploader parameters")),
      IngestStoreError: (error) =>
        logIngestStoreFailure(error).pipe(Effect.as(failure(-32603, "Ingest storage unavailable"))),
      TraceStoreError: (error) =>
        logStoreFailure(error).pipe(Effect.as(failure(-32603, "Trace storage unavailable"))),
      TraceIndexError: (error) =>
        logIndexFailure(error).pipe(Effect.as(failure(-32603, "Trace content search unavailable"))),
    }),
  );
});

/** Scheme, host, and port the request was addressed to: the Website when forwarded from it. */
const requestOrigin = (request: HttpServerRequest.HttpServerRequest) =>
  URL.parse(request.originalUrl)?.origin ?? `https://${request.headers.host ?? "localhost"}`;

/** A path-mounting router, such as just-be.dev's `/traces`, names its mount in this header. */
const isMounted = (request: HttpServerRequest.HttpServerRequest) =>
  request.headers["x-forwarded-prefix"] !== undefined;

const skillFilesPrefix = `/install/skills/${SKILL_NAME}/`;

// Public, cacheable for a few minutes, and never rendered: scripts are served as plain text.
const skillFileHeaders = (contentType: string) => ({
  "content-type": `${contentType}; charset=utf-8`,
  "cache-control": "public, max-age=300",
  "x-content-type-options": "nosniff",
});

export const apiRoutes = Layer.mergeAll(
  HttpRouter.add(
    "GET",
    "/install",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      return HttpServerResponse.text(
        yield* readInstallGuide({ origin: requestOrigin(request), mounted: isMounted(request) }),
        {
          headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": "no-store" },
        },
      );
    }),
  ),
  HttpRouter.add(
    "GET",
    "/install/skills/*",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const path = new URL(request.url, "http://local").pathname;
      if (path === `${skillFilesPrefix}manifest.json`)
        return HttpServerResponse.jsonUnsafe(
          { skill: yield* skillEntry(), files: yield* skillManifest() },
          { headers: skillFileHeaders("application/json") },
        );
      const file = path.startsWith(skillFilesPrefix)
        ? fileAtPath(path.slice(skillFilesPrefix.length))
        : undefined;
      if (!file) return json({ error: "Not found" }, 404);
      return HttpServerResponse.text(file.text, {
        headers: skillFileHeaders(
          file.mimeType === "text/markdown" ? "text/markdown" : "text/plain",
        ),
      });
    }),
  ),
  HttpRouter.add(
    "POST",
    "/api/uploaders/claim",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const claimed = yield* claimUploader(
        request.json.pipe(Effect.mapError(() => new InvalidClaimCode())),
      );
      return json(claimed);
    }).pipe(Effect.catch(httpFailure)),
  ),
  HttpRouter.add(
    "POST",
    "/api/ingest",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      // Bound the body before it's buffered and parsed; the uploader sends ~4 MB at most.
      const length = Number(request.headers["content-length"] ?? Number.NaN);
      const body: Effect.Effect<unknown, InvalidIngestBatch | TraceEventTooLarge> =
        Number.isSafeInteger(length) && length <= MAX_BATCH_BYTES
          ? request.json.pipe(Effect.mapError(() => new InvalidIngestBatch()))
          : Effect.fail(
              new TraceEventTooLarge({
                length: Number.isSafeInteger(length) ? length : -1,
                limit: MAX_BATCH_BYTES,
              }),
            );
      const result = yield* ingestBatch(request.headers.authorization, body);
      return json(result);
    }).pipe(Effect.catch(httpFailure)),
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
  // Public by design: the showcase owner's aggregate usage, served from a snapshot
  // the cron keeps fresh. Browsers and caches may reuse it briefly.
  HttpRouter.add(
    "GET",
    "/api/stats",
    publicUsageStats().pipe(
      Effect.map((snapshot) =>
        HttpServerResponse.jsonUnsafe(snapshot.stats, {
          headers: {
            "cache-control": "public, max-age=60, stale-while-revalidate=300",
            "last-modified": new Date(snapshot.generatedAt).toUTCString(),
            "x-content-type-options": "nosniff",
          },
        }),
      ),
      Effect.catch(httpFailure),
    ),
  ),
  HttpRouter.add("POST", "/mcp", mcp.pipe(Effect.catch(httpFailure))),
  HttpRouter.add("*", "*", json({ error: "Not found" }, 404)),
);
