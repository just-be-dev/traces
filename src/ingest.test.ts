import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import {
  claimUploader,
  createUploader,
  entryEvent,
  entryKey,
  entryTools,
  entryTrace,
  type IngestBatch,
  ingestBatch,
  SessionStore,
  UploaderId,
  UploaderStore,
} from "./ingest.ts";
import { Identity, Owner, TraceStore } from "./traces.ts";

const claudeToolUse = {
  type: "assistant",
  uuid: "c-1",
  message: {
    role: "assistant",
    content: [
      { type: "text", text: "Reading" },
      { type: "tool_use", name: "Read", input: {} },
      { type: "tool_use", name: "Read", input: {} },
      { type: "tool_use", name: "Grep", input: {} },
    ],
  },
};
const codexCall = {
  timestamp: "2026-10-12T22:25:48.341Z",
  type: "response_item",
  ordinal: 7,
  payload: { type: "function_call", name: "exec_command", arguments: "{}" },
};
const piToolCall = {
  type: "message",
  id: "p-1",
  message: { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: {} }] },
};
const piToolResult = {
  type: "message",
  id: "p-2",
  message: { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "ok" }] },
};

test("entry keys prefer each harness's own entry ID and fall back to the byte offset", () => {
  expect(entryKey("claude-code", claudeToolUse, 10)).toBe("c-1");
  expect(entryKey("claude-code", { type: "ai-title" }, 10)).toBe("@10");
  expect(entryKey("codex", codexCall, 10)).toBe("#7");
  expect(entryKey("codex", { type: "session_meta", ordinal: "7" }, 10)).toBe("@10");
  expect(entryKey("pi", piToolCall, 10)).toBe("p-1");
  expect(entryKey("pi", [1, 2], 10)).toBe("@10");
  expect(entryKey("omp", piToolCall, 10)).toBe("p-1");
  expect(entryKey("omp", { type: "title", title: "t", pad: "  " }, 0)).toBe("@0");
});

test("entry events and tool names follow each harness's transcript shape", () => {
  expect(entryEvent("claude-code", claudeToolUse)).toBe("assistant");
  expect(entryTools("claude-code", claudeToolUse)).toEqual(["Read", "Grep"]);
  expect(entryEvent("codex", codexCall)).toBe("response_item/function_call");
  expect(entryTools("codex", codexCall)).toEqual(["exec_command"]);
  expect(entryEvent("pi", piToolCall)).toBe("message/assistant");
  expect(entryTools("pi", piToolCall)).toEqual(["bash"]);
  expect(entryEvent("pi", piToolResult)).toBe("message/toolResult");
  expect(entryTools("pi", piToolResult)).toEqual(["bash"]);
  expect(entryEvent("pi", "not an object")).toBe("entry");
  // omp, a pi fork, writes the same entry shapes.
  expect(entryEvent("omp", piToolCall)).toBe("message/assistant");
  expect(entryTools("omp", piToolCall)).toEqual(["bash"]);
  expect(entryEvent("omp", piToolResult)).toBe("message/toolResult");
  expect(entryTools("omp", piToolResult)).toEqual(["bash"]);
  expect(entryTools("claude-code", { message: { content: "plain" } })).toEqual([]);
});

// Conductor rows: a session header, a user prompt, and Claude Agent SDK messages.
const conductorHeader = {
  type: "session",
  session: { id: "cs-1", agent_type: "claude", title: "T", created_at: "2025-09-14 02:22:43" },
  workspace: { id: "w-1", workspace_path: "/w" },
};
const conductorPrompt = {
  id: "row-1",
  session_id: "cs-1",
  role: "user",
  content: "Create a PR",
  created_at: "2025-09-14 02:32:19",
};
const conductorRow = (id: string, content: unknown) => ({
  id,
  session_id: "cs-1",
  role: "assistant",
  content,
  created_at: "2026-06-28T22:04:39.846Z",
});
const conductorToolUse = conductorRow("row-2", { ...claudeToolUse, session_id: "sdk-1" });
const conductorInit = conductorRow("row-3", { type: "system", subtype: "init", cwd: "/w" });

test("Conductor rows are keyed by row ID and mapped from the SDK message they carry", () => {
  expect(entryKey("conductor", conductorHeader, 0)).toBe("session");
  expect(entryKey("conductor", conductorPrompt, 5)).toBe("row-1");
  expect(entryKey("conductor", conductorToolUse, 6)).toBe("row-2");
  expect(entryKey("conductor", { role: "user" }, 7)).toBe("@7");
  // A row whose own type field happens to say "session" is not the header.
  expect(entryKey("conductor", { ...conductorPrompt, type: "session" }, 5)).toBe("row-1");
  expect(entryEvent("conductor", conductorHeader)).toBe("session");
  expect(entryEvent("conductor", conductorPrompt)).toBe("user");
  expect(entryEvent("conductor", conductorToolUse)).toBe("assistant");
  expect(entryEvent("conductor", conductorInit)).toBe("system/init");
  // Content that didn't parse stays a string; the row's role still names it.
  expect(entryEvent("conductor", conductorRow("row-4", '{"type":'))).toBe("assistant");
  expect(entryTools("conductor", conductorToolUse)).toEqual(["Read", "Grep"]);
  expect(entryTools("conductor", conductorPrompt)).toEqual([]);
  expect(entryTools("conductor", conductorHeader)).toEqual([]);
});

test("Conductor traces take the row's creation time, reading SQLite's format as UTC", () => {
  const batch: IngestBatch = {
    client: { harness: "conductor", uploaderVersion: "1" },
    session: { id: "cs-1", stream: "cs-1" },
    entries: [conductorHeader, conductorPrompt, conductorToolUse, { role: "user" }].map(
      (raw, offset) => ({ offset, raw: raw as IngestBatch["entries"][number]["raw"] }),
    ),
  };
  const traces = batch.entries.map((entry) =>
    entryTrace(Owner.make("owner"), batch, entry, "2026-10-01T00:00:00.000Z"),
  );
  expect(traces.map((trace) => [trace.id, trace.occurredAt, trace.summary])).toEqual([
    ["conductor:cs-1:session", "2025-09-14T02:22:43.000Z", "session"],
    ["conductor:cs-1:row-1", "2025-09-14T02:32:19.000Z", "user"],
    ["conductor:cs-1:row-2", "2026-06-28T22:04:39.846Z", "Read, Grep"],
    ["conductor:cs-1:@3", "2026-10-01T00:00:00.000Z", "user"],
  ]);
  expect(traces[2]?.raw as unknown).toEqual(conductorToolUse);
});

const owner = Owner.make("owner");
const layer = Layer.mergeAll(
  Layer.succeed(Identity, { owner: Effect.succeed(owner) }),
  UploaderStore.memory,
  SessionStore.memory,
  TraceStore.memory,
);

test("concurrent claims of one code yield exactly one token", async () => {
  const outcomes = await Effect.runPromise(
    Effect.gen(function* () {
      const { claimCode } = yield* createUploader({ harness: "pi" });
      return yield* Effect.all(
        Array.from({ length: 5 }, () =>
          Effect.result(claimUploader(Effect.succeed({ code: claimCode }))),
        ),
        { concurrency: "unbounded" },
      );
    }).pipe(Effect.provide(layer)),
  );
  expect(outcomes.filter((outcome) => outcome._tag === "Success")).toHaveLength(1);
});

test("an expired claim can't be used", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* UploaderStore;
      yield* store.create({
        owner,
        id: UploaderId.make("upl_0000000000000000"),
        label: "old",
        harness: "codex",
        claimHash: "hash",
        claimExpiresAt: "2000-01-01T00:00:00.000Z",
        createdAt: "2000-01-01T00:00:00.000Z",
      });
      return yield* store.claim("hash", "token", new Date().toISOString());
    }).pipe(Effect.provide(layer)),
  );
  expect(result).toEqual(Option.none());
});

test("a rejected token never reads the body", async () => {
  const outcome = await Effect.runPromise(
    Effect.result(ingestBatch("Bearer nope", Effect.die("body was read"))).pipe(
      Effect.provide(layer),
    ),
  );
  expect(outcome._tag === "Failure" && outcome.failure._tag).toBe("Unauthenticated");
});

const batchOf = (stream: string, entries: Array<{ offset: number; raw: unknown }>) => ({
  client: { harness: "claude-code", uploaderVersion: "0.1.0" },
  session: { id: "session-1", stream },
  entries,
});

test("a subagent stream's entries are qualified by their session", async () => {
  const ids = await Effect.runPromise(
    Effect.gen(function* () {
      const { claimCode } = yield* createUploader({ harness: "claude-code" });
      const { token } = yield* claimUploader(Effect.succeed({ code: claimCode }));
      const entries = [{ offset: 0, raw: { type: "ai-title" } }];
      yield* ingestBatch(`Bearer ${token}`, Effect.succeed(batchOf("session-1", entries)));
      yield* ingestBatch(`Bearer ${token}`, Effect.succeed(batchOf("agent-a1", entries)));
      const traces = yield* (yield* TraceStore).unindexed(10, 1_000_000);
      return traces.map((trace) => String(trace.id)).sort();
    }).pipe(Effect.provide(layer)),
  );
  expect(ids).toEqual(["claude-code:session-1/agent-a1:@0", "claude-code:session-1:@0"]);
});

test("a batch over the total byte cap is rejected before anything is stored", async () => {
  const outcome = await Effect.runPromise(
    Effect.gen(function* () {
      const { claimCode } = yield* createUploader({ harness: "claude-code" });
      const { token } = yield* claimUploader(Effect.succeed({ code: claimCode }));
      const entry = (offset: number) => ({ offset, raw: { text: "x".repeat(990_000) } });
      const result = yield* Effect.result(
        ingestBatch(
          `Bearer ${token}`,
          Effect.succeed(
            batchOf(
              "session-1",
              Array.from({ length: 9 }, (_, n) => entry(n)),
            ),
          ),
        ),
      );
      const stored = yield* (yield* TraceStore).unindexed(10, 100_000_000);
      return { result, stored: stored.length };
    }).pipe(Effect.provide(layer)),
  );
  expect(outcome.result._tag === "Failure" && outcome.result.failure._tag).toBe(
    "TraceEventTooLarge",
  );
  expect(outcome.stored).toBe(0);
});
