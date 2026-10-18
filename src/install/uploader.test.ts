import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cursorPathFor,
  deriveSession,
  extractMetadata,
  listSessionFiles,
  MAX_BATCH_ENTRIES,
  MAX_LINE_BYTES,
  pendingFiles,
  pendingPathFor,
  transcriptPaths,
  type UploadOptions,
  uploadFile,
} from "./skill/install-traces/scripts/traces.ts";

const SCRIPT = join(import.meta.dir, "skill/install-traces/scripts/traces.ts");
const TOKEN = "secret-token-do-not-print";

interface Received {
  readonly authorization: string | null;
  readonly body: {
    client: Record<string, string>;
    session: Record<string, string>;
    entries: Array<{ offset: number; raw: unknown }>;
  };
}

// The fake ingest server answers with `respond`, which tests replace.
let respond: (request: Received) => Response | Promise<Response>;
let received: Array<Received>;
let server: ReturnType<typeof Bun.serve>;
// Requests that arrived by following a redirect, which the client must never do.
let followed: number;
let home: string;
let work: string;

const accept = (request: Received) =>
  Response.json({
    received: request.body.entries.length,
    inserted: request.body.entries.length,
  });

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/followed") {
        followed++;
        return Response.json({ uploaderId: "upl_evil", token: TOKEN, received: 1 });
      }
      if (url.pathname === "/api/uploaders/claim") {
        const { code } = (await request.json()) as { code: string };
        if (code === "redirect") return Response.redirect(`${url.origin}/followed`, 307);
        return code === "good-code"
          ? Response.json({ uploaderId: "upl_1", token: TOKEN })
          : Response.json({ error: "invalid claim code" }, { status: 401 });
      }
      if (url.pathname !== "/api/ingest" || request.method !== "POST") {
        return new Response("not found", { status: 404 });
      }
      const entry: Received = {
        authorization: request.headers.get("authorization"),
        body: (await request.json()) as Received["body"],
      };
      received.push(entry);
      return respond(entry);
    },
  });
});

afterAll(() => server.stop(true));

beforeEach(() => {
  received = [];
  followed = 0;
  respond = accept;
  home = mkdtempSync(join(tmpdir(), "traces-home-"));
  work = mkdtempSync(join(tmpdir(), "traces-work-"));
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({ url: server.url.origin, token: TOKEN, uploaderId: "upl_1" }),
  );
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});

const options = (): UploadOptions => ({
  home,
  env: {},
  harnessVersion: "9.9.9",
  retryDelaysMs: [1, 1, 1],
  lockPollMs: 5,
});

const jsonl = (...values: Array<unknown>) => values.map((v) => `${JSON.stringify(v)}\n`).join("");
const sentOffsets = () => received.flatMap((r) => r.body.entries.map((e) => e.offset));
const sentRaw = () => received.flatMap((r) => r.body.entries.map((e) => e.raw));
const cursorOf = (harness: "claude-code" | "codex" | "pi" | "omp", file: string) =>
  JSON.parse(readFileSync(cursorPathFor(home, harness, file), "utf8")) as {
    offset: number;
    head: string;
    cwd?: string;
  };

test("derives session and stream IDs from each harness's file layout", () => {
  const uuid = "d30430f1-00d8-4f61-a807-91f662e0b716";
  expect(deriveSession("claude-code", `/h/.claude/projects/-proj/${uuid}.jsonl`)).toEqual({
    id: uuid,
    stream: uuid,
  });
  expect(
    deriveSession("claude-code", `/h/.claude/projects/-proj/${uuid}/subagents/agent-af2d27.jsonl`),
  ).toEqual({ id: uuid, stream: "agent-af2d27" });
  const codex = "01a13238-d4cf-74e2-808b-7e64616f2f69";
  expect(
    deriveSession(
      "codex",
      `/h/.codex/sessions/2026/10/12/rollout-2026-10-12T18-25-48-${codex}.jsonl`,
    ),
  ).toEqual({ id: codex, stream: codex });
  const pi = "01a132a1-7d8f-7038-b04b-a980c9bd18e1";
  expect(
    deriveSession("pi", `/h/.pi/agent/sessions/--x--/2026-10-13T00-20-06-674Z_${pi}.jsonl`),
  ).toEqual({ id: pi, stream: pi });
  const omp = "019f6dd1-12fe-7000-9453-58b7c3a789af";
  const ompSession = `/h/.omp/agent/sessions/-Code-x/2026-07-17T02-04-06-270Z_${omp}`;
  expect(deriveSession("omp", `${ompSession}.jsonl`)).toEqual({ id: omp, stream: omp });
  expect(deriveSession("omp", `${ompSession}/IngestionScout.jsonl`)).toEqual({
    id: omp,
    stream: "IngestionScout",
  });
  expect(deriveSession("omp", `${ompSession}/Planner/Scout.jsonl`)).toEqual({
    id: omp,
    stream: "Planner/Scout",
  });
  expect(deriveSession("omp", "/tmp/odd-name.jsonl")).toEqual({
    id: "odd-name",
    stream: "odd-name",
  });
  expect(deriveSession("pi", "/tmp/odd-name.jsonl")).toEqual({
    id: "odd-name",
    stream: "odd-name",
  });
  expect(deriveSession("codex", "/tmp/rollout-x.jsonl")).toEqual({
    id: "rollout-x",
    stream: "rollout-x",
  });
});

test("reads cwd and harness version where each harness records them", () => {
  expect(extractMetadata("claude-code", { cwd: "/a", version: "2.1.0", type: "user" })).toEqual({
    cwd: "/a",
    harnessVersion: "2.1.0",
  });
  expect(
    extractMetadata("codex", { type: "session_meta", payload: { cwd: "/b", cli_version: "0.1" } }),
  ).toEqual({ cwd: "/b", harnessVersion: "0.1" });
  expect(extractMetadata("codex", { type: "event_msg", payload: { cwd: "/b" } })).toEqual({});
  expect(extractMetadata("pi", { type: "session", cwd: "/c", version: 3 })).toEqual({
    cwd: "/c",
  });
  expect(extractMetadata("omp", { type: "session", cwd: "/d", version: 3 })).toEqual({
    cwd: "/d",
  });
});

test("sends only new complete lines and persists the cursor", async () => {
  const file = join(work, "11111111-1111-4111-8111-111111111111.jsonl");
  const first = jsonl({ type: "user", cwd: "/repo", n: 1 }, { type: "assistant", n: 2 });
  writeFileSync(file, first);
  const one = await uploadFile("claude-code", file, options());
  expect(one).toMatchObject({ outcome: "uploaded", sent: 2, inserted: 2 });
  expect(sentOffsets()).toEqual([
    0,
    Buffer.byteLength(jsonl({ type: "user", cwd: "/repo", n: 1 })),
  ]);
  expect(received[0]?.authorization).toBe(`Bearer ${TOKEN}`);
  expect(received[0]?.body.client).toMatchObject({
    harness: "claude-code",
    harnessVersion: "9.9.9",
    uploaderVersion: "0.1.0",
  });
  expect(received[0]?.body.session).toEqual({
    id: "11111111-1111-4111-8111-111111111111",
    stream: "11111111-1111-4111-8111-111111111111",
    cwd: "/repo",
  });
  expect(cursorOf("claude-code", file).offset).toBe(Buffer.byteLength(first));

  received = [];
  expect(await uploadFile("claude-code", file, options())).toMatchObject({ outcome: "unchanged" });
  expect(received).toEqual([]);

  appendFileSync(file, jsonl({ type: "user", n: 3 }));
  await uploadFile("claude-code", file, options());
  expect(sentRaw()).toEqual([{ type: "user", n: 3 }]);
  expect(sentOffsets()).toEqual([Buffer.byteLength(first)]);
  // The cached cwd still accompanies later deltas.
  expect(received[0]?.body.session.cwd).toBe("/repo");
});

test("a symlinked path to the same file shares its cursor", async () => {
  const file = join(work, "real.jsonl");
  writeFileSync(file, jsonl({ n: 1 }));
  const link = join(work, "link");
  symlinkSync(work, link);
  await uploadFile("pi", file, options());
  received = [];
  expect(await uploadFile("pi", join(link, "real.jsonl"), options())).toMatchObject({
    outcome: "unchanged",
  });
  expect(received).toEqual([]);
});

test("holds back a trailing partial line until it is completed", async () => {
  const file = join(work, "partial.jsonl");
  writeFileSync(file, `${jsonl({ n: 1 })}{"n":`);
  await uploadFile("pi", file, options());
  expect(sentRaw()).toEqual([{ n: 1 }]);
  expect(cursorOf("pi", file).offset).toBe(Buffer.byteLength(jsonl({ n: 1 })));

  received = [];
  appendFileSync(file, "2}\n");
  await uploadFile("pi", file, options());
  expect(sentRaw()).toEqual([{ n: 2 }]);
});

test("starts over when the first line changes or the file shrinks", async () => {
  const file = join(work, "rewrite.jsonl");
  writeFileSync(file, jsonl({ n: 1 }, { n: 2 }));
  await uploadFile("codex", file, options());
  received = [];
  writeFileSync(file, jsonl({ n: 10 }, { n: 2 }, { n: 3 }));
  await uploadFile("codex", file, options());
  expect(sentRaw()).toEqual([{ n: 10 }, { n: 2 }, { n: 3 }]);

  received = [];
  writeFileSync(file, jsonl({ n: 10 }));
  await uploadFile("codex", file, options());
  expect(sentRaw()).toEqual([{ n: 10 }]);
});

test("an omp title slot rewritten in place doesn't restart the file", async () => {
  const file = join(work, "omp.jsonl");
  const slot = (title: string) =>
    jsonl({ type: "title", v: 1, title, updatedAt: "t", pad: " ".repeat(40 - title.length) });
  const rest = jsonl({ type: "session", id: "s", cwd: "/repo" }, { type: "message", id: "m1" });
  writeFileSync(file, `${slot("")}${rest}`);
  expect(await uploadFile("omp", file, options())).toMatchObject({ sent: 3 });
  expect(received[0]?.body.session.cwd).toBe("/repo");

  // omp overwrites the slot with a same-length line when the title changes.
  received = [];
  writeFileSync(file, `${slot("New title")}${rest}${jsonl({ type: "message", id: "m2" })}`);
  await uploadFile("omp", file, options());
  expect(sentRaw()).toEqual([{ type: "message", id: "m2" }]);

  // A different session header still means a rewritten file, even one that grew.
  received = [];
  const other = jsonl(
    { type: "session", id: "other", cwd: "/repo" },
    { type: "message", id: "m1" },
  );
  writeFileSync(file, `${slot("")}${other}${jsonl({ type: "message", id: "m2" })}`);
  expect(statSync(file).size).toBeGreaterThan(Buffer.byteLength(`${slot("")}${rest}`) + 30);
  await uploadFile("omp", file, options());
  expect(sentRaw()).toHaveLength(4);
});

test("skips oversize, blank, and invalid lines but moves the cursor past them", async () => {
  const file = join(work, "oversize.jsonl");
  const huge = JSON.stringify({ text: "x".repeat(MAX_LINE_BYTES) });
  const content = `${jsonl({ n: 1 })}${huge}\n\nnot json\n${jsonl({ n: 2 })}`;
  writeFileSync(file, content);
  const outcome = await uploadFile("pi", file, options());
  expect(outcome).toMatchObject({ sent: 2, skipped: 2 });
  expect(sentRaw()).toEqual([{ n: 1 }, { n: 2 }]);
  expect(cursorOf("pi", file).offset).toBe(Buffer.byteLength(content));
  const log = readFileSync(join(home, "upload.log"), "utf8");
  expect(log).toContain(
    `skipped oversize entry offset=${Buffer.byteLength(jsonl({ n: 1 }))} bytes=${huge.length} file=oversize.jsonl`,
  );
  expect(log).not.toContain("xxxx");

  // Skipped lines alone still advance the cursor.
  received = [];
  appendFileSync(file, `${huge}\n`);
  await uploadFile("pi", file, options());
  expect(received).toEqual([]);
  expect(cursorOf("pi", file).offset).toBe(statSync(file).size);
});

test("batches at most 200 entries per request", async () => {
  const file = join(work, "many.jsonl");
  writeFileSync(file, jsonl(...Array.from({ length: 250 }, (_, n) => ({ n }))));
  await uploadFile("pi", file, options());
  expect(received.map((r) => r.body.entries.length)).toEqual([MAX_BATCH_ENTRIES, 50]);
});

test("splits batches that are too large and skips a single entry that is", async () => {
  const file = join(work, "split.jsonl");
  writeFileSync(file, jsonl({ n: 1 }, { n: 2, bad: true }, { n: 3 }, { n: 4 }));
  respond = (request) => {
    if (request.body.entries.length > 2) return new Response("too large", { status: 413 });
    if (request.body.entries.some((e) => (e.raw as { bad?: boolean }).bad)) {
      return Response.json({ error: "too large" }, { status: 413 });
    }
    return accept(request);
  };
  const outcome = await uploadFile("pi", file, options());
  expect(outcome).toMatchObject({ outcome: "uploaded", sent: 3, skipped: 1 });
  expect(received.map((r) => r.body.entries.length)).toEqual([4, 2, 1, 1, 2]);
  expect(cursorOf("pi", file).offset).toBe(statSync(file).size);
  expect(readFileSync(join(home, "upload.log"), "utf8")).toContain(
    `skipped rejected entry offset=${Buffer.byteLength(jsonl({ n: 1 }))} status=413`,
  );
});

test("a 400 or 422 stops the file without splitting or skipping anything", async () => {
  const file = join(work, "envelope.jsonl");
  writeFileSync(file, jsonl({ n: 1 }, { n: 2 }));
  for (const status of [400, 422]) {
    received = [];
    respond = () => Response.json({ error: "invalid envelope" }, { status });
    expect(await uploadFile("pi", file, options())).toMatchObject({
      outcome: "failed",
      skipped: 0,
    });
    expect(received).toHaveLength(1);
    expect(existsSync(cursorPathFor(home, "pi", file))).toBe(false);
    expect(readFileSync(join(home, "upload.log"), "utf8")).toContain(
      `upload rejected status=${status} file=envelope.jsonl`,
    );
  }
});

test("a 2xx counts only when the server confirms every entry", async () => {
  const file = join(work, "confirm.jsonl");
  writeFileSync(file, jsonl({ n: 1 }, { n: 2 }));
  for (const body of [{ received: 1, inserted: 1 }, {}, "ok"]) {
    respond = () => (typeof body === "string" ? new Response(body) : Response.json(body));
    expect(await uploadFile("pi", file, options())).toMatchObject({ outcome: "failed" });
    expect(existsSync(cursorPathFor(home, "pi", file))).toBe(false);
  }
  respond = accept;
  expect(await uploadFile("pi", file, options())).toMatchObject({ outcome: "uploaded", sent: 2 });
});

test("redirects are never followed", async () => {
  const file = join(work, "redirect.jsonl");
  writeFileSync(file, jsonl({ n: 1 }));
  respond = () => Response.redirect(`${server.url.origin}/followed`, 307);
  expect(await uploadFile("pi", file, options())).toMatchObject({ outcome: "failed" });
  expect(followed).toBe(0);
  expect(existsSync(cursorPathFor(home, "pi", file))).toBe(false);
});

test("a timed-out batch is split until it gets through", async () => {
  const file = join(work, "slow.jsonl");
  writeFileSync(file, jsonl({ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }));
  respond = async (request) => {
    if (request.body.entries.length > 1) await Bun.sleep(300);
    return accept(request);
  };
  const outcome = await uploadFile("pi", file, { ...options(), requestTimeoutMs: 100 });
  expect(outcome).toMatchObject({ outcome: "uploaded", sent: 4, skipped: 0 });
  expect(received.map((r) => r.body.entries.length)).toEqual([4, 2, 1, 1, 2, 1, 1]);
  expect(cursorOf("pi", file).offset).toBe(statSync(file).size);
});

test("a single entry that times out is retried, never skipped", async () => {
  const file = join(work, "stuck.jsonl");
  writeFileSync(file, jsonl({ n: 1 }));
  respond = async (request) => {
    await Bun.sleep(300);
    return accept(request);
  };
  const outcome = await uploadFile("pi", file, { ...options(), requestTimeoutMs: 50 });
  expect(outcome).toMatchObject({ outcome: "failed", sent: 0, skipped: 0 });
  expect(received).toHaveLength(4);
  expect(existsSync(cursorPathFor(home, "pi", file))).toBe(false);
  expect(pendingFiles(home, "pi")).toEqual([file]);
});

test("a rejected token stops without advancing the cursor", async () => {
  const file = join(work, "auth.jsonl");
  writeFileSync(file, jsonl({ n: 1 }));
  respond = () => Response.json({ error: "unauthorized" }, { status: 401 });
  expect(await uploadFile("pi", file, options())).toMatchObject({ outcome: "unauthorized" });
  expect(received).toHaveLength(1);
  expect(existsSync(cursorPathFor(home, "pi", file))).toBe(false);
  const log = readFileSync(join(home, "upload.log"), "utf8");
  expect(log).toContain("token rejected; re-run login");
  expect(log).not.toContain(TOKEN);
});

test("server errors are retried, then the cursor stays for next time", async () => {
  const file = join(work, "retry.jsonl");
  writeFileSync(file, jsonl({ n: 1 }));
  respond = () => new Response("unavailable", { status: 503 });
  expect(await uploadFile("pi", file, options())).toMatchObject({ outcome: "failed" });
  expect(received).toHaveLength(4);
  expect(existsSync(cursorPathFor(home, "pi", file))).toBe(false);

  // A transient failure that clears is retried within the same upload.
  received = [];
  let failures = 1;
  respond = (request) => (failures-- > 0 ? new Response("busy", { status: 429 }) : accept(request));
  expect(await uploadFile("pi", file, options())).toMatchObject({ outcome: "uploaded", sent: 1 });
  expect(received).toHaveLength(2);
});

test("concurrent uploads of one file don't send a line twice", async () => {
  const file = join(work, "race.jsonl");
  writeFileSync(file, jsonl(...Array.from({ length: 30 }, (_, n) => ({ n }))));
  respond = async (request) => {
    await Bun.sleep(20);
    return accept(request);
  };
  const results = await Promise.all([
    uploadFile("pi", file, options()),
    uploadFile("pi", file, options()),
    uploadFile("pi", file, options()),
  ]);
  expect(results.reduce((sum, r) => sum + r.sent, 0)).toBe(30);
  expect(sentOffsets()).toHaveLength(30);
  expect(new Set(sentOffsets()).size).toBe(30);
  expect(existsSync(`${cursorPathFor(home, "pi", file)}.lock`)).toBe(false);
});

test("a lock left by a dead process is taken over", async () => {
  const file = join(work, "stale.jsonl");
  writeFileSync(file, jsonl({ n: 1 }));
  const lock = `${cursorPathFor(home, "pi", file)}.lock`;
  mkdirSync(lock, { recursive: true });
  const dead = Bun.spawnSync(["true"]).pid;
  writeFileSync(
    join(lock, "owner.json"),
    JSON.stringify({ pid: dead, host: (await import("node:os")).hostname() }),
  );
  expect(await uploadFile("pi", file, { ...options(), lockTimeoutMs: 1000 })).toMatchObject({
    sent: 1,
  });
});

test("a failed or locked-out file stays pending until a later upload gets it through", async () => {
  const failed = join(work, "failed.jsonl");
  const locked = join(work, "locked.jsonl");
  const current = join(work, "current.jsonl");
  writeFileSync(failed, jsonl({ file: "failed" }));
  writeFileSync(locked, jsonl({ file: "locked" }));
  writeFileSync(current, jsonl({ file: "current" }));

  respond = () => new Response("unavailable", { status: 503 });
  expect(await uploadFile("pi", failed, options())).toMatchObject({ outcome: "failed" });
  respond = accept;
  const lock = `${cursorPathFor(home, "pi", locked)}.lock`;
  mkdirSync(lock, { recursive: true });
  expect(await uploadFile("pi", locked, { ...options(), lockTimeoutMs: 30 })).toMatchObject({
    outcome: "locked",
  });
  rmSync(lock, { recursive: true });
  expect(readFileSync(join(home, "upload.log"), "utf8")).toContain(
    "lock busy; queued as pending for the next upload file=locked.jsonl",
  );
  expect(pendingFiles(home, "pi").sort()).toEqual([failed, locked].sort());

  // The next turn's upload names only the current session but retries the rest.
  received = [];
  const next = await run(["upload", "pi", current]);
  expect(next.code).toBe(0);
  const [first, ...retried] = sentRaw();
  expect(first).toEqual({ file: "current" });
  // Pending files are retried in directory order, which is by digest.
  expect(retried.map((raw) => (raw as { file: string }).file).sort()).toEqual(["failed", "locked"]);
  expect(pendingFiles(home, "pi")).toEqual([]);
  expect(existsSync(pendingPathFor(home, "pi", failed))).toBe(false);

  // A pending file that has since disappeared is cleared too.
  writeFileSync(pendingPathFor(home, "pi", join(work, "gone.jsonl")), join(work, "gone.jsonl"));
  expect((await run(["upload", "pi", current])).code).toBe(0);
  expect(pendingFiles(home, "pi")).toEqual([]);
});

test("hook transcript paths expand ~/ and ignore relative paths", () => {
  expect(
    transcriptPaths(
      { transcript_path: "~/.claude/projects/p/s.jsonl", agent_transcript_path: "relative.jsonl" },
      "/Users/me",
    ),
  ).toEqual(["/Users/me/.claude/projects/p/s.jsonl"]);
  expect(
    transcriptPaths({ transcript_path: "/a.jsonl", agent_transcript_path: "/a.jsonl" }, "/h"),
  ).toEqual(["/a.jsonl"]);
  expect(transcriptPaths({ transcript_path: "~other/a.jsonl", agent_transcript_path: 3 })).toEqual(
    [],
  );
});

test("lists session files newest first, including Claude subagents", () => {
  const claude = join(work, "claude");
  const subagents = join(claude, "projects", "-p", "s1", "subagents");
  mkdirSync(subagents, { recursive: true });
  writeFileSync(join(claude, "projects", "-p", "s1.jsonl"), "");
  writeFileSync(join(subagents, "agent-a.jsonl"), "");
  writeFileSync(join(claude, "projects", "-p", "notes.txt"), "");
  const files = listSessionFiles("claude-code", { CLAUDE_CONFIG_DIR: claude }).map((f) => f.path);
  expect(files.sort()).toEqual(
    [join(claude, "projects", "-p", "s1.jsonl"), join(subagents, "agent-a.jsonl")].sort(),
  );
  const codex = join(work, "codex");
  mkdirSync(join(codex, "archived_sessions"), { recursive: true });
  writeFileSync(join(codex, "archived_sessions", "rollout-a.jsonl"), "");
  expect(listSessionFiles("codex", { CODEX_HOME: codex })).toHaveLength(1);
});

const run = async (args: Array<string>, stdin?: string) => {
  const child = Bun.spawn([process.execPath, SCRIPT, ...args], {
    env: { ...process.env, TRACES_HOME: home, TRACES_HARNESS_VERSION: "9.9.9" },
    stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code };
};

test("login writes a private config and never prints the token", async () => {
  rmSync(join(home, "config.json"));
  const ok = await run(["login", "--url", server.url.origin, "--code", "good-code"]);
  expect(ok).toMatchObject({ code: 0, stdout: "Logged in as uploader upl_1\n" });
  expect(ok.stdout + ok.stderr).not.toContain(TOKEN);
  const config = join(home, "config.json");
  expect(statSync(config).mode & 0o777).toBe(0o600);
  expect(statSync(home).mode & 0o777).toBe(0o700);
  expect(JSON.parse(readFileSync(config, "utf8"))).toEqual({
    url: server.url.origin,
    token: TOKEN,
    uploaderId: "upl_1",
  });

  const status = await run(["status"]);
  expect(status.code).toBe(0);
  expect(status.stdout).toContain("uploader: upl_1");
  expect(status.stdout).not.toContain(TOKEN);

  const bad = await run(["login", "--url", server.url.origin, "--code", "nope"]);
  expect(bad.code).toBe(1);
  expect(bad.stderr).toContain("claim code invalid or expired");

  const insecure = await run(["login", "--url", "http://example.com", "--code", "good-code"]);
  expect(insecure.code).toBe(1);

  rmSync(config);
  const redirected = await run(["login", "--url", server.url.origin, "--code", "redirect"]);
  expect(redirected.code).toBe(1);
  expect(followed).toBe(0);
  expect(existsSync(config)).toBe(false);
});

test("the hook exits at once, silently, and uploads in the background", async () => {
  const transcript = join(work, "22222222-2222-4222-8222-222222222222.jsonl");
  const agent = join(work, "agent.jsonl");
  writeFileSync(transcript, jsonl({ type: "user", n: 1 }));
  writeFileSync(agent, jsonl({ type: "user", n: 2 }));
  const hook = await run(
    ["hook", "claude-code"],
    JSON.stringify({
      hook_event_name: "SubagentStop",
      transcript_path: transcript,
      agent_transcript_path: agent,
    }),
  );
  expect(hook).toMatchObject({ code: 0, stdout: "" });
  for (let i = 0; i < 100 && sentRaw().length < 2; i++) await Bun.sleep(50);
  expect(sentRaw()).toEqual([
    { type: "user", n: 1 },
    { type: "user", n: 2 },
  ]);

  rmSync(join(home, "config.json"));
  const unconfigured = await run(
    ["hook", "codex"],
    JSON.stringify({ transcript_path: transcript }),
  );
  expect(unconfigured).toMatchObject({ code: 0, stdout: "" });
  const garbage = await run(["hook", "codex"], "not json");
  expect(garbage).toMatchObject({ code: 0, stdout: "", stderr: "" });
});
