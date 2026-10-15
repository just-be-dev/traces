import { afterAll, beforeAll, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apiRoutes } from "../api.ts";
import { SessionStore, UploaderStore } from "../ingest.ts";
import { AppInfo } from "../service.ts";
import { Identity, Owner, TraceIndex, TraceStore } from "../traces.ts";
import { Showcase, TimeZone, UsageStore } from "../usage.ts";
import { InstallAddress } from "./guide.ts";

// Both sides of the ingest boundary: the uploader CLI the skill ships, run as a
// subprocess against the real routes with memory services. The MCP call is signed
// in (Access); the uploader's requests carry only its bearer token.

const SCRIPT = join(import.meta.dir, "skill/install-traces/scripts/traces.ts");

const runtime = ManagedRuntime.make(
  Layer.mergeAll(
    AppInfo.layer("Traces"),
    Layer.succeed(InstallAddress, {
      apiUrl: Effect.succeed("https://api.example.test"),
      publicOrigin: Option.none(),
    }),
    Layer.succeed(Identity, { owner: Effect.succeed(Owner.make("owner")) }),
    TraceStore.memory,
    TraceIndex.memory,
    UploaderStore.memory,
    SessionStore.memory,
    UsageStore.memory,
    Layer.succeed(Showcase, { owner: Owner.make("owner"), timeZone: TimeZone.make("UTC") }),
  ),
);
const handle = (request: Request) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const http = yield* HttpRouter.toHttpEffect(apiRoutes);
      const response = yield* http.pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(request),
        ),
      );
      return HttpServerResponse.toWeb(response);
    }).pipe(Effect.scoped),
  );

let server: ReturnType<typeof Bun.serve>;
let origin: string;
let home: string;
let projects: string;

beforeAll(() => {
  server = Bun.serve({ port: 0, fetch: handle });
  origin = `http://localhost:${server.port}`;
  home = mkdtempSync(join(tmpdir(), "traces-e2e-"));
  projects = join(home, "claude", "projects", "-work");
  mkdirSync(projects, { recursive: true });
});

afterAll(async () => {
  server.stop(true);
  rmSync(home, { recursive: true, force: true });
  await runtime.dispose();
});

// Async: the server runs in this process, so a blocking spawn would deadlock it.
const cli = async (...args: Array<string>) => {
  const child = Bun.spawn([process.execPath, SCRIPT, ...args], {
    env: {
      ...process.env,
      TRACES_HOME: join(home, ".traces"),
      CLAUDE_CONFIG_DIR: join(home, "claude"),
      TRACES_HARNESS_VERSION: "2.1.296",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
};

const tool = async (name: string, args?: unknown) => {
  const response = await handle(
    new Request(`${origin}/mcp`, {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    }),
  );
  const reply = (await response.json()) as { result: { content: Array<{ text: string }> } };
  return JSON.parse(reply.result.content[0]?.text ?? "null");
};

const line = (value: unknown) => `${JSON.stringify(value)}\n`;

test("create_uploader → login → turn-end uploads → list_sessions and search", async () => {
  const { claimCode, uploaderId } = await tool("create_uploader", { harness: "claude-code" });
  const login = await cli("login", "--url", origin, "--code", claimCode);
  expect(login.code).toBe(0);
  expect(login.stdout).toContain(uploaderId);
  expect(login.stdout + login.stderr).not.toContain("trc_");

  const session = "11111111-2222-3333-4444-555555555555";
  const transcript = join(projects, `${session}.jsonl`);
  writeFileSync(
    transcript,
    line({
      type: "user",
      uuid: "u-1",
      cwd: "/work",
      timestamp: "2026-10-09T12:00:00.000Z",
      message: { role: "user", content: "list files" },
    }) +
      line({
        type: "assistant",
        uuid: "a-1",
        cwd: "/work",
        timestamp: "2026-10-09T12:00:01.000Z",
        message: { content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }] },
      }),
  );
  expect((await cli("upload", "claude-code", transcript)).code).toBe(0);
  // Next turn: only the new line goes up, and a repeat sends nothing.
  appendFileSync(
    transcript,
    line({
      type: "assistant",
      uuid: "a-2",
      timestamp: "2026-10-09T12:00:02.000Z",
      message: { content: [{ type: "text", text: "done" }] },
    }),
  );
  expect((await cli("upload", "claude-code", transcript)).code).toBe(0);
  expect((await cli("upload", "claude-code", transcript)).code).toBe(0);

  const sessions = await tool("list_sessions");
  expect(sessions).toEqual([
    expect.objectContaining({
      source: "claude-code",
      sessionId: session,
      harnessVersion: "2.1.296",
      uploaderId,
      cwd: "/work",
      entries: 3,
    }),
  ]);
  const traces = await tool("search_traces", { query: session });
  expect(traces.map((trace: { id: string }) => trace.id)).toEqual([
    `claude-code:${session}:a-2`,
    `claude-code:${session}:a-1`,
    `claude-code:${session}:u-1`,
  ]);
  expect(traces[1].summary).toBe("Bash");

  // A revoked uploader is refused and its cursor doesn't move.
  await tool("revoke_uploader", { id: uploaderId });
  appendFileSync(transcript, line({ type: "user", uuid: "u-2", message: { content: "more" } }));
  await cli("upload", "claude-code", transcript);
  expect((await tool("list_sessions"))[0].entries).toBe(3);
});
