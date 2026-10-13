import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as References from "effect/References";
import * as Tracer from "effect/Tracer";
import { apiRoutes, traceRequest } from "./api.ts";
import { SessionStore, UploaderStore } from "./ingest.ts";
import { InstallAddress } from "./install/guide.ts";
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
  insertMany: () => Effect.die("unexpected write"),
  search: () => Effect.die("unexpected read"),
  get: () => Effect.die("unexpected read"),
  unindexed: () => Effect.die("unexpected read"),
  markIndexed: () => Effect.die("unexpected write"),
});
const storeFailure = (operation: TraceStoreError["operation"]) =>
  Effect.fail(new TraceStoreError({ operation, cause: new Error("D1") }));
const failingStore = Layer.succeed(TraceStore, {
  insert: () => storeFailure("insert"),
  insertMany: () => storeFailure("insertMany"),
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
  uploaderStore: Layer.Layer<UploaderStore> = UploaderStore.memory,
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
      uploaderStore,
      SessionStore.memory,
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
    // Downloads and uploads use the origin the page was requested from (the Website).
    expect(instructions).toContain("`ORIGIN` = `https://public.example.test`");
    expect(instructions).toContain(
      "https://public.example.test/install/skills/install-traces/scripts/traces.ts",
    );
    expect(instructions).toContain("skill://install-traces/SKILL.md");
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
      await (
        await handler(new Request("http://app/install/skills/install-traces/SKILL.md"))
      ).text(),
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
    expect(await error(rpc(1, "prompts/list"))).toEqual({
      code: -32601,
      message: "Unknown method",
    });
    expect(await error(rpc(1, "resources/read", { uri: "skill://install-traces/../x" }))).toEqual({
      code: -32602,
      message: "Unknown resource",
    });
    expect(await error(rpc(1, "skills/get", { uri: "skill://other/SKILL.md" }))).toEqual({
      code: -32602,
      message: "Unknown resource",
    });
    expect(await error(rpc(1, "resources/read", {}))).toEqual({
      code: -32602,
      message: "Invalid parameters",
    });
    expect(
      await error(rpc(1, "tools/call", { name: "create_uploader", arguments: { harness: "amp" } })),
    ).toEqual({ code: -32602, message: "Invalid uploader parameters" });
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
      "create_uploader",
      "list_uploaders",
      "revoke_uploader",
      "list_sessions",
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

const sha256 = async (text: string) =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");

test("the install skill is served over MCP and HTTP with one manifest of the served bytes", async () => {
  const { handler, dispose } = serve(signedIn, untouchedStore, "Traces", untouchedIndex);
  try {
    const initialize = (await body(await handler(rpc(1, "initialize")))).result;
    expect(initialize.capabilities.extensions).toEqual({
      "io.modelcontextprotocol/skills": { directoryRead: true },
    });
    expect(initialize.instructions).toContain("skill://install-traces/SKILL.md");
    const discover = (await body(await handler(rpc(1, "server/discover")))).result;
    expect(discover.resultType).toBe("complete");
    expect(discover.capabilities).toEqual(initialize.capabilities);

    const listed = (await body(await handler(rpc(2, "skills/list")))).result;
    expect(listed).toMatchObject({ resultType: "complete", cacheScope: "public" });
    expect(listed.skills).toHaveLength(1);
    const [skill] = listed.skills;
    expect(skill.uri).toBe("skill://install-traces/SKILL.md");
    expect(skill.frontmatter.name).toBe("install-traces");
    expect(skill.frontmatter.description).toContain("Claude Code, Codex, or pi");
    const got = (
      await body(await handler(rpc(3, "skills/get", { uri: "skill://install-traces/SKILL.md" })))
    ).result;
    expect(got.skill).toEqual(skill);

    const uris = skill.resources.map((resource: { uri: string }) => resource.uri);
    for (const path of [
      "SKILL.md",
      "references/claude-code.md",
      "references/codex.md",
      "references/pi.md",
      "scripts/traces.ts",
      "extensions/traces.ts",
    ])
      expect(uris).toContain(`skill://install-traces/${path}`);
    const resources = (await body(await handler(rpc(4, "resources/list")))).result.resources;
    expect(resources.map((resource: { uri: string }) => resource.uri)).toEqual(uris);

    const manifest = await body(
      await handler(
        new Request("https://public.example.test/install/skills/install-traces/manifest.json"),
      ),
    );
    expect(manifest.skill).toEqual(skill);
    // Every file reads the same over MCP and HTTP, and matches its manifest digest and size.
    for (const resource of skill.resources as Array<{
      uri: string;
      digest: string;
      size: number;
    }>) {
      const read = (await body(await handler(rpc(5, "resources/read", { uri: resource.uri }))))
        .result;
      const text: string = read.contents[0].text;
      expect(read.contents[0].uri).toBe(resource.uri);
      expect(resource.digest).toBe(`sha256:${await sha256(text)}`);
      expect(resource.size).toBe(new TextEncoder().encode(text).length);
      const path = resource.uri.slice("skill://install-traces/".length);
      const download = await handler(
        new Request(`https://public.example.test/install/skills/install-traces/${path}`),
      );
      expect(download.status).toBe(200);
      expect(download.headers.get("x-content-type-options")).toBe("nosniff");
      expect(download.headers.get("content-type")).not.toContain("javascript");
      expect(await download.text()).toBe(text);
    }
    const directory = (
      await body(
        await handler(rpc(6, "resources/directory/read", { uri: "skill://install-traces" })),
      )
    ).result.resources;
    expect(directory).toContainEqual({
      uri: "skill://install-traces/references",
      name: "references",
      mimeType: "inode/directory",
    });
    expect(directory).toContainEqual({
      uri: "skill://install-traces/SKILL.md",
      name: "SKILL.md",
      mimeType: "text/markdown",
    });
    expect(
      (
        await handler(
          new Request("https://public.example.test/install/skills/install-traces/../../api/health"),
        )
      ).status,
    ).not.toBe(200);
    expect(
      (
        await handler(
          new Request("https://public.example.test/install/skills/install-traces/nope.ts"),
        )
      ).status,
    ).toBe(404);
    const install = await (
      await handler(new Request("https://public.example.test/install"))
    ).text();
    for (const resource of manifest.files as Array<{ sha256: string }>)
      expect(install).toContain(resource.sha256);
  } finally {
    await dispose();
  }
});

const batch = (entries: Array<{ offset: number; raw: unknown }>) => ({
  client: {
    harness: "claude-code",
    harnessVersion: "2.1.296",
    uploaderVersion: "0.1.0",
    host: "laptop",
    platform: "darwin-arm64",
  },
  session: { id: "session-T", stream: "session-T", cwd: "/work" },
  entries,
});

// A network request carries content-length; a constructed Request doesn't, so set it.
const ingest = (token: string | undefined, payload: unknown, length?: number) => {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload);
  return new Request("https://public.example.test/api/ingest", {
    method: "POST",
    headers: {
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      "content-length": String(length ?? new TextEncoder().encode(text).length),
    },
    body: text,
  });
};

const claim = (code: unknown) =>
  new Request("https://public.example.test/api/uploaders/claim", {
    method: "POST",
    body: JSON.stringify({ code }),
  });

test("an uploader created over MCP claims a token once and streams transcript slices", async () => {
  const signedInServer = serve(signedIn, TraceStore.memory);
  try {
    const { handler } = signedInServer;
    const call = async (name: string, args?: unknown) =>
      JSON.parse(
        (await body(await handler(rpc(1, "tools/call", { name, arguments: args })))).result
          .content[0].text,
      );
    const created = await call("create_uploader", { harness: "claude-code", label: "laptop" });
    expect(created.claimCode).toMatch(/^tcl_[0-9a-f]{32}$/);
    expect(created.uploaderId).toMatch(/^upl_[0-9a-f]{16}$/);

    const claimed = await handler(claim(created.claimCode));
    expect(claimed.status).toBe(200);
    const { token, uploaderId } = await body(claimed);
    expect(uploaderId).toBe(created.uploaderId);
    expect(token).toMatch(/^trc_[0-9a-f]{64}$/);
    // Single use.
    expect((await handler(claim(created.claimCode))).status).toBe(401);
    expect((await handler(claim("not-a-code"))).status).toBe(401);

    const first = [
      {
        offset: 0,
        raw: {
          type: "assistant",
          uuid: "u-1",
          timestamp: "2026-10-09T12:00:00.000Z",
          message: { content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }] },
        },
      },
      { offset: 120, raw: { type: "ai-title", title: "Fix the build" } },
    ];
    const uploaded = await handler(ingest(token, batch(first)));
    expect(uploaded.status).toBe(200);
    expect(await body(uploaded)).toEqual({ received: 2, inserted: 2 });
    // A retried slice is a no-op.
    expect(await body(await handler(ingest(token, batch(first))))).toEqual({
      received: 2,
      inserted: 0,
    });

    const events = (await body(await handler(new Request("http://app/api/events?q=session-T"))))
      .events;
    expect(
      events.map((found: { id: string; event: string; summary: string; raw: unknown }) => [
        found.id,
        found.event,
        found.summary,
      ]),
    ).toEqual([
      // No timestamp, so it's dated at receipt: newer than the timestamped entry.
      ["claude-code:session-T:@120", "ai-title", "ai-title"],
      ["claude-code:session-T:u-1", "assistant", "Bash"],
    ]);
    expect(events.find((found: { id: string }) => found.id.endsWith("u-1")).raw).toEqual(
      first[0]?.raw,
    );

    const sessions = await call("list_sessions");
    expect(sessions).toEqual([
      expect.objectContaining({
        source: "claude-code",
        sessionId: "session-T",
        harnessVersion: "2.1.296",
        uploaderVersion: "0.1.0",
        uploaderId,
        host: "laptop",
        platform: "darwin-arm64",
        cwd: "/work",
        entries: 2,
      }),
    ]);
    const uploaders = await call("list_uploaders");
    expect(uploaders).toEqual([expect.objectContaining({ id: uploaderId, label: "laptop" })]);
    expect(JSON.stringify(uploaders)).not.toContain(token);

    expect(await call("revoke_uploader", { id: uploaderId })).toEqual({ revoked: true });
    expect((await handler(ingest(token, batch(first)))).status).toBe(401);
  } finally {
    await signedInServer.dispose();
  }
});

test("ingest needs a valid bearer token, not Access, and checks it before the body", async () => {
  // The Website forwards without an Access identity; the uploader token is the credential.
  const failing = Layer.succeed(UploaderStore, {
    create: () => Effect.die("unexpected"),
    claim: () => Effect.die("unexpected"),
    authenticate: () => Effect.succeed(Option.none()),
    list: () => Effect.die("unexpected"),
    revoke: () => Effect.die("unexpected"),
  });
  const { handler, dispose } = serve(anonymous, untouchedStore, "Traces", untouchedIndex, failing);
  try {
    const entries = [{ offset: 0, raw: {} }];
    expect((await handler(ingest(undefined, batch(entries)))).status).toBe(401);
    expect((await handler(ingest("trc_short", batch(entries)))).status).toBe(401);
    expect((await handler(ingest(`trc_${"0".repeat(64)}`, "{not json"))).status).toBe(401);
    // Creating an uploader needs Access.
    expect(
      (
        await handler(
          rpc(1, "tools/call", { name: "create_uploader", arguments: { harness: "pi" } }),
        )
      ).status,
    ).toBe(401);
  } finally {
    await dispose();
  }
});

test("ingest rejects malformed and oversized batches without storing anything", async () => {
  const { handler, dispose } = serve(signedIn, TraceStore.memory);
  try {
    const created = JSON.parse(
      (
        await body(
          await handler(
            rpc(1, "tools/call", { name: "create_uploader", arguments: { harness: "codex" } }),
          ),
        )
      ).result.content[0].text,
    );
    const { token } = await body(await handler(claim(created.claimCode)));
    expect((await handler(ingest(token, batch([])))).status).toBe(400);
    // The declared body size is checked before the body is read.
    const entries = [{ offset: 0, raw: {} }];
    expect((await handler(ingest(token, batch(entries), 8_000_001))).status).toBe(413);
    const unsized = ingest(token, batch(entries));
    unsized.headers.delete("content-length");
    expect((await handler(unsized)).status).toBe(413);
    expect((await handler(ingest(token, { ...batch([{ offset: -1, raw: {} }]) }))).status).toBe(
      400,
    );
    expect(
      (
        await handler(
          ingest(token, { ...batch([{ offset: 0, raw: {} }]), client: { harness: "amp" } }),
        )
      ).status,
    ).toBe(400);
    const huge = await handler(
      ingest(
        token,
        batch([
          { offset: 0, raw: { type: "ok" } },
          { offset: 10, raw: { text: "é".repeat(500_001) } },
        ]),
      ),
    );
    expect(huge.status).toBe(413);
    expect(await body(await handler(new Request("http://app/api/events?q=session-T")))).toEqual({
      events: [],
    });
  } finally {
    await dispose();
  }
});
