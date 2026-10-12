import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as References from "effect/References";
import * as Tracer from "effect/Tracer";
import { apiRoutes, traceRequest } from "./api.ts";
import { InstallAddress } from "./install.ts";
import { AppInfo } from "./service.ts";
import {
  Identity,
  Owner,
  TraceIndex,
  TraceIndexError,
  TraceStore,
  TraceStoreError,
  Unauthenticated,
} from "./traces.ts";

const installAddress = Layer.succeed(InstallAddress, {
  apiUrl: Effect.succeed("https://api.example.test"),
});
const signedIn = Layer.succeed(Identity, { owner: Effect.succeed(Owner.make("owner")) });
const anonymous = Layer.succeed(Identity, { owner: Effect.fail(new Unauthenticated()) });
const untouchedStore = Layer.succeed(TraceStore, {
  insert: () => Effect.die("unexpected write"),
  search: () => Effect.die("unexpected read"),
  get: () => Effect.die("unexpected read"),
  unindexed: () => Effect.die("unexpected read"),
  markIndexed: () => Effect.die("unexpected write"),
});
const storeFailure = (operation: TraceStoreError["operation"]) =>
  Effect.fail(new TraceStoreError({ operation, cause: new Error("D1") }));
const failingStore = Layer.succeed(TraceStore, {
  insert: () => storeFailure("insert"),
  search: () => storeFailure("search"),
  get: () => storeFailure("get"),
  unindexed: () => storeFailure("unindexed"),
  markIndexed: () => storeFailure("markIndexed"),
});
const untouchedIndex = Layer.succeed(TraceIndex, {
  index: () => Effect.die("unexpected index"),
  search: () => Effect.die("unexpected search"),
});
const indexFailure = (operation: TraceIndexError["operation"]) =>
  Effect.fail(new TraceIndexError({ operation, cause: new Error("AI Search unavailable") }));
const failingIndex = Layer.succeed(TraceIndex, {
  index: () => indexFailure("index"),
  search: () => indexFailure("search"),
});

// Serves requests the way the API Worker does: router wrapped in the request span.
const serve = (
  identity: Layer.Layer<Identity>,
  store: Layer.Layer<TraceStore>,
  name = "Traces",
  index: Layer.Layer<TraceIndex> = TraceIndex.memory,
) => {
  const spans: Array<Tracer.NativeSpan> = [];
  const tracer = Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options);
      spans.push(span);
      return span;
    },
  });
  const logs: Array<{ message: unknown; annotations: unknown }> = [];
  const capture = Logger.make((options) => {
    logs.push({
      message: options.message,
      annotations: options.fiber.getRef(References.CurrentLogAnnotations),
    });
  });
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      AppInfo.layer(name),
      installAddress,
      identity,
      store,
      index,
      Logger.layer([capture]),
    ),
  );
  const handler = (request: Request) =>
    runtime.runPromise(
      Effect.gen(function* () {
        const http = yield* HttpRouter.toHttpEffect(apiRoutes);
        const response = yield* traceRequest(http).pipe(
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            HttpServerRequest.fromWeb(request),
          ),
        );
        return HttpServerResponse.toWeb(response);
      }).pipe(Effect.scoped, Effect.withTracer(tracer)),
    );
  return { handler, spans, logs, dispose: () => runtime.dispose() };
};

const post = (path: string, body: unknown) =>
  new Request(`http://app${path}`, {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const rpc = (id: number, method: string, params?: unknown) =>
  post("/mcp", { jsonrpc: "2.0", id, method, params });
const body = async (response: Response) => JSON.parse(await response.text());

const event = {
  id: "event-1",
  source: "claude-code",
  sessionId: "session-A",
  event: "PostToolUse",
  occurredAt: "2026-10-09T12:00:00Z",
  raw: { hook_event_name: "PostToolUse", tool_name: "Read", tool_input: { file: "private.txt" } },
};
const stored = { ...event, owner: "owner", summary: "Read" };

test("health reads the supplied capability and unknown routes return JSON errors", async () => {
  const { handler, dispose } = serve(anonymous, untouchedStore, "Different project");
  try {
    const health = await handler(new Request("http://app/api/health"));
    expect(health.status).toBe(200);
    expect(await health.text()).toBe(JSON.stringify({ name: "Different project", status: "ok" }));
    expect(health.headers.get("cache-control")).toBe("no-store");
    const missing = await handler(new Request("http://app/api/missing"));
    expect(missing.status).toBe(404);
    expect(await missing.text()).toBe(JSON.stringify({ error: "Not found" }));
    const install = await handler(new Request("https://public.example.test/install"));
    expect(install.status).toBe(200);
    expect(install.headers.get("content-type")).toStartWith("text/markdown");
    const instructions = await install.text();
    expect(instructions).toContain("codex mcp add traces --url https://api.example.test/mcp");
    expect(instructions).toContain("amp clone just-be/traces");
    expect(instructions).toContain("/absolute/path/to/traces/scripts/submit-hook.ts");
    expect(instructions).not.toContain("https://public.example.test/mcp");
  } finally {
    await dispose();
  }
});

test("authenticated ingestion preserves source payloads, deduplicates, and searches normalized fields", async () => {
  const { handler, dispose } = serve(signedIn, TraceStore.memory);
  try {
    expect((await handler(post("/api/events", event))).status).toBe(201);
    const repeat = await handler(post("/api/events", { ...event, raw: { tool_name: "Edit" } }));
    expect(repeat.status).toBe(200);
    expect(await body(repeat)).toEqual({ inserted: false });
    expect(await body(await handler(new Request("http://app/api/events?q=session-A")))).toEqual({
      events: [stored],
    });
    const search = await handler(
      rpc(1, "tools/call", { name: "search_traces", arguments: { query: "read" } }),
    );
    expect(JSON.parse((await body(search)).result.content[0].text)).toEqual([stored]);
    const inspection = await handler(rpc(2, "tools/call", { name: "inspect_hooks" }));
    expect((await body(inspection)).result.content[0].text).toBe(
      await (await handler(new Request("http://app/install"))).text(),
    );
    const notification = post("/mcp", { jsonrpc: "2.0", method: "notifications/initialized" });
    expect((await handler(notification)).status).toBe(202);
  } finally {
    await dispose();
  }
});

test("malformed submissions, queries, and MCP calls are rejected without storage access", async () => {
  const { handler, dispose } = serve(signedIn, untouchedStore, "Traces", untouchedIndex);
  try {
    expect((await handler(post("/api/events", {}))).status).toBe(400);
    expect((await handler(post("/api/events", "{not json"))).status).toBe(400);
    expect((await handler(post("/api/events", { ...event, id: "" }))).status).toBe(400);
    const oversized = await handler(
      post("/api/events", { ...event, raw: { content: "x".repeat(64_001) } }),
    );
    expect(oversized.status).toBe(413);
    expect((await handler(new Request("http://app/api/events"))).status).toBe(400);
    expect((await handler(new Request(`http://app/api/events?q=${"x".repeat(201)}`))).status).toBe(
      400,
    );
    expect((await handler(new Request("http://app/api/search"))).status).toBe(400);
    expect((await handler(new Request(`http://app/api/search?q=${"x".repeat(201)}`))).status).toBe(
      400,
    );
    const error = async (request: Request) => (await body(await handler(request))).error;
    expect(await error(post("/mcp", "{not json"))).toEqual({
      code: -32700,
      message: "Parse error",
    });
    expect(await error(post("/mcp", { jsonrpc: "2.0" }))).toEqual({
      code: -32600,
      message: "Invalid request",
    });
    expect(await error(rpc(1, "resources/list"))).toEqual({
      code: -32601,
      message: "Unknown method",
    });
    expect(await error(rpc(2, "tools/call", { name: "delete_traces" }))).toEqual({
      code: -32601,
      message: "Unknown tool",
    });
    expect(await error(rpc(3, "tools/call", { name: "search_traces", arguments: {} }))).toEqual({
      code: -32602,
      message: "Invalid query",
    });
    expect(await error(rpc(4, "tools/call", "search_traces"))).toEqual({
      code: -32602,
      message: "Invalid parameters",
    });
    expect(
      await error(rpc(5, "tools/call", { name: "search_trace_contents", arguments: {} })),
    ).toEqual({ code: -32602, message: "Invalid query" });
  } finally {
    await dispose();
  }
});

test("storage failures answer 503 or a JSON-RPC internal error instead of crashing", async () => {
  const { handler, logs, dispose } = serve(signedIn, failingStore);
  try {
    const write = await handler(post("/api/events", event));
    expect(write.status).toBe(503);
    expect(await body(write)).toEqual({ error: "Trace storage unavailable" });
    expect((await handler(new Request("http://app/api/events?q=session-A"))).status).toBe(503);
    const search = await handler(
      rpc(1, "tools/call", { name: "search_traces", arguments: { query: "Read" } }),
    );
    expect((await body(search)).error).toEqual({
      code: -32603,
      message: "Trace storage unavailable",
    });
    expect(logs.map((log) => log.annotations)).toEqual([
      { "traces.operation": "insert" },
      { "traces.operation": "search" },
      { "traces.operation": "search" },
    ]);
    const logged = JSON.stringify(logs);
    for (const secret of ["session-A", "private.txt", "event-1"])
      expect(logged).not.toContain(secret);
  } finally {
    await dispose();
  }
});

test("unidentified requests cannot read or submit traces or invoke MCP", async () => {
  const { handler, dispose } = serve(anonymous, untouchedStore, "Traces", untouchedIndex);
  try {
    for (const [path, method] of [
      ["/api/search?q=private", "GET"],
      ["/api/events", "GET"],
      ["/api/events", "POST"],
      ["/mcp", "POST"],
    ]) {
      expect((await handler(new Request(`http://app${path}`, { method }))).status).toBe(401);
    }
    expect((await handler(post("/api/events", event))).status).toBe(401);
    expect((await handler(rpc(1, "tools/list"))).status).toBe(401);
  } finally {
    await dispose();
  }
});

test("content search finds payload text over HTTP and MCP, scoped to the signed-in owner", async () => {
  const { handler, dispose } = serve(signedIn, TraceStore.memory);
  try {
    expect((await handler(post("/api/events", event))).status).toBe(201);
    const other = { ...event, id: "event-2", raw: { tool_input: { file: "notes.md" } } };
    expect((await handler(post("/api/events", other))).status).toBe(201);
    const search = await handler(new Request("http://app/api/search?q=PRIVATE.t"));
    expect(search.status).toBe(200);
    expect(search.headers.get("cache-control")).toBe("no-store");
    expect(await body(search)).toEqual({ events: [stored] });
    expect(await body(await handler(new Request("http://app/api/search?q=private+notes")))).toEqual(
      { events: [] },
    );
    const tools = await body(await handler(rpc(1, "tools/list")));
    expect(tools.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "search_traces",
      "search_trace_contents",
      "inspect_hooks",
    ]);
    const mcp = await handler(
      rpc(2, "tools/call", { name: "search_trace_contents", arguments: { query: "notes.md" } }),
    );
    expect(JSON.parse((await body(mcp)).result.content[0].text)).toEqual([
      { ...stored, id: "event-2", raw: other.raw, summary: "PostToolUse" },
    ]);
  } finally {
    await dispose();
  }
  // Another owner's identity sees none of it.
  const stranger = serve(
    Layer.succeed(Identity, { owner: Effect.succeed(Owner.make("stranger")) }),
    TraceStore.memory,
  );
  try {
    expect(
      await body(await stranger.handler(new Request("http://app/api/search?q=private"))),
    ).toEqual({ events: [] });
  } finally {
    await stranger.dispose();
  }
});

test("an index outage keeps ingestion working and content search answers 503 or -32603", async () => {
  const { handler, logs, dispose } = serve(signedIn, TraceStore.memory, "Traces", failingIndex);
  try {
    expect((await handler(post("/api/events", event))).status).toBe(201);
    expect(await body(await handler(new Request("http://app/api/events?q=session-A")))).toEqual({
      events: [stored],
    });
    const search = await handler(new Request("http://app/api/search?q=private"));
    expect(search.status).toBe(503);
    expect(await body(search)).toEqual({ error: "Trace content search unavailable" });
    const mcp = await handler(
      rpc(1, "tools/call", { name: "search_trace_contents", arguments: { query: "private" } }),
    );
    expect((await body(mcp)).error).toEqual({
      code: -32603,
      message: "Trace content search unavailable",
    });
    expect(logs.map((log) => log.annotations)).toEqual([
      { "traces.operation": "index" },
      { "traces.operation": "search" },
      { "traces.operation": "search" },
    ]);
    const logged = JSON.stringify(logs);
    for (const secret of ["session-A", "private", "event-1"]) expect(logged).not.toContain(secret);
  } finally {
    await dispose();
  }
});

test("requests produce named spans without queries or payloads in attributes", async () => {
  const { handler, spans, dispose } = serve(signedIn, TraceStore.memory);
  try {
    await handler(post("/api/events", event));
    await handler(new Request("http://app/api/events?q=session-A"));
    await handler(
      rpc(1, "tools/call", { name: "search_traces", arguments: { query: "session-A" } }),
    );
    await handler(new Request("http://app/api/search?q=private.txt"));

    const names = spans.map((span) => span.name);
    for (const name of [
      "Api.request",
      "Traces.authorize",
      "Traces.submit",
      "Traces.search",
      "Traces.searchContents",
      "Traces.index",
      "Mcp.dispatch",
      "Mcp.callTool",
    ])
      expect(names).toContain(name);

    const submit = spans.find((span) => span.name === "Traces.submit");
    expect(Object.fromEntries(submit?.attributes ?? [])).toEqual({
      "traces.source": "claude-code",
      "traces.inserted": true,
      "traces.indexed": true,
    });
    const contents = spans.find((span) => span.name === "Traces.searchContents");
    expect(Object.fromEntries(contents?.attributes ?? [])).toEqual({ "traces.results": 1 });
    const requests = spans.filter((span) => span.name === "Api.request");
    expect(requests.map((span) => span.kind)).toEqual(["server", "server", "server", "server"]);
    expect(Object.fromEntries(requests[1]?.attributes ?? [])).toEqual({
      "http.request.method": "GET",
      "url.path": "/api/events",
      "http.route": "/api/events",
      "http.response.status_code": 200,
    });
    // Each operation span nests under the request span for its request.
    const request = requests[0];
    const ancestors = (span: Tracer.AnySpan): Array<Tracer.AnySpan> =>
      span._tag === "Span" && span.parent._tag === "Some"
        ? [span.parent.value, ...ancestors(span.parent.value)]
        : [];
    expect(submit && ancestors(submit)).toContain(request);

    const recorded = JSON.stringify(spans.map((span) => [...span.attributes.values()]));
    for (const secret of ["session-A", "private.txt", "tool_input", "event-1"])
      expect(recorded).not.toContain(secret);
  } finally {
    await dispose();
  }
});
