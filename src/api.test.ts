import { expect, test } from "bun:test";
import * as HttpRouter from "effect/http/HttpRouter";
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import { InstallAddress } from "./install.ts";
import { AppInfo } from "./service.ts";
import { apiRoutes } from "./api.ts";
import { Identity, TraceStore } from "./traces.ts";

const installAddress = Layer.succeed(InstallAddress, {
  apiUrl: Effect.succeed("https://api.example.test"),
});

test("health reads the supplied capability and unknown routes return JSON errors", async () => {
  const { handler, dispose } = HttpRouter.toWebHandler(
    apiRoutes.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          AppInfo.layer("Different project"),
          installAddress,
          Layer.succeed(Identity, { owner: Effect.succeed(null) }),
          Layer.succeed(TraceStore, {
            insert: () => Effect.succeed(false),
            search: () => Effect.succeed([]),
          }),
        ),
      ),
    ),
    { disableLogger: true },
  );
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
  const events = new Map<string, import("./traces.ts").Trace>();
  const { handler, dispose } = HttpRouter.toWebHandler(
    apiRoutes.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          AppInfo.layer("Traces"),
          installAddress,
          Layer.succeed(Identity, { owner: Effect.succeed("owner") }),
          Layer.succeed(TraceStore, {
            insert: (event) =>
              Effect.sync(() => {
                const key = `${event.owner}:${event.id}`;
                if (events.has(key)) return false;
                events.set(key, event);
                return true;
              }),
            search: (owner, query) =>
              Effect.sync(() =>
                [...events.values()].filter(
                  (event) =>
                    event.owner === owner &&
                    (event.sessionId === query || event.summary.includes(query)),
                ),
              ),
          }),
        ),
      ),
    ),
    { disableLogger: true },
  );
  try {
    const raw = {
      hook_event_name: "PostToolUse",
      tool_name: "Read",
      tool_input: { file: "private.txt" },
    };
    const event = {
      id: "event-1",
      source: "claude-code",
      sessionId: "session-A",
      event: "PostToolUse",
      occurredAt: "2026-10-09T12:00:00Z",
      raw,
    };
    const submit = () =>
      handler(
        new Request("http://app/api/events", { method: "POST", body: JSON.stringify(event) }),
      );
    expect((await submit()).status).toBe(201);
    expect(JSON.parse(await (await submit()).text())).toEqual({ inserted: false });
    expect(
      JSON.parse(await (await handler(new Request("http://app/api/events?q=session-A"))).text()),
    ).toEqual({ events: [{ ...event, owner: "owner", summary: "Read" }] });
    const rpc = await handler(
      new Request("http://app/mcp", {
        method: "POST",
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "search_traces", arguments: { query: "Read" } },
        }),
      }),
    );
    expect(JSON.parse(JSON.parse(await rpc.text()).result.content[0].text)).toEqual([
      { ...event, owner: "owner", summary: "Read" },
    ]);
    const inspection = await handler(
      new Request("http://app/mcp", {
        method: "POST",
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "inspect_hooks" },
        }),
      }),
    );
    expect(JSON.parse(await inspection.text()).result.content[0].text).toBe(
      await (await handler(new Request("http://app/install"))).text(),
    );
    expect(
      (await handler(new Request("http://app/api/events", { method: "POST", body: "{}" }))).status,
    ).toBe(400);
    expect(
      (
        await handler(
          new Request("http://app/api/events", {
            method: "POST",
            body: JSON.stringify({
              ...event,
              id: "oversized",
              raw: { content: "x".repeat(64_001) },
            }),
          }),
        )
      ).status,
    ).toBe(413);
    expect(
      (
        await handler(
          new Request("http://app/mcp", {
            method: "POST",
            body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
          }),
        )
      ).status,
    ).toBe(202);
  } finally {
    await dispose();
  }
});

test("unidentified requests cannot read or submit traces or invoke MCP", async () => {
  const { handler, dispose } = HttpRouter.toWebHandler(
    apiRoutes.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          AppInfo.layer("Traces"),
          installAddress,
          Layer.succeed(Identity, { owner: Effect.succeed(null) }),
          Layer.succeed(TraceStore, {
            insert: () => Effect.die("unexpected write"),
            search: () => Effect.die("unexpected read"),
          }),
        ),
      ),
    ),
    { disableLogger: true },
  );
  try {
    for (const [path, method] of [
      ["/api/events", "GET"],
      ["/api/events", "POST"],
      ["/mcp", "POST"],
    ]) {
      expect((await handler(new Request(`http://app${path}`, { method }))).status).toBe(401);
    }
  } finally {
    await dispose();
  }
});
