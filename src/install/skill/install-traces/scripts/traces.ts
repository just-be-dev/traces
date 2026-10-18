#!/usr/bin/env node
// Traces uploader. Runs on the user's machine with `bun traces.ts` or `node traces.ts`
// (Node >= 22.18). It is a single file with no dependencies beyond `node:*`, written
// in erasable TypeScript only.
//
//   login --url <origin> --code <claim code>   exchange a one-time claim code for a token
//   hook <claude-code|codex>                   agent hook: upload this turn in the background
//   upload <harness> <file...> [--harness-version <v>]
//   sync <claude-code|codex|pi|omp|all>        backfill every existing session file
//   status                                     show login and upload progress
//
// It never prints or logs tokens or payload contents. Logs hold file basenames,
// offsets, counts, and HTTP statuses only.

import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const UPLOADER_VERSION = "0.1.0";
export const HARNESSES = ["claude-code", "codex", "pi", "omp"] as const;
export type Harness = (typeof HARNESSES)[number];

/** Lines longer than this many UTF-8 bytes are skipped, not uploaded. */
export const MAX_LINE_BYTES = 1_000_000;
export const MAX_BATCH_ENTRIES = 200;
export const MAX_BATCH_BYTES = 4 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_RETRY_DELAYS_MS: ReadonlyArray<number> = [500, 2000, 5000];
const LOCK_POLL_MS = 250;
const LOCK_TIMEOUT_MS = 120_000;
const LOCK_STALE_MS = 10 * 60_000;
const LOG_MAX_BYTES = 5 * 1024 * 1024;
const VERSION_CACHE_MS = 24 * 60 * 60_000;
const VERSION_TIMEOUT_MS = 5000;
/** How far into a file to look for its cwd and harness version. */
const METADATA_SCAN_LINES = 200;
const METADATA_SCAN_BYTES = 4 * 1024 * 1024;
const READ_CHUNK_BYTES = 1024 * 1024;

const utf8 = new TextDecoder();
const USER_AGENT = `traces-uploader/${UPLOADER_VERSION}`;
const UUID_AT_END = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

type Env = Readonly<Record<string, string | undefined>>;

export interface Config {
  readonly url: string;
  readonly token: string;
  readonly uploaderId: string;
}

export interface Cursor {
  readonly path: string;
  readonly offset: number;
  /** SHA-256 of the file's first line; a change means the file was rewritten. */
  readonly head?: string;
  readonly cwd?: string;
  /** Harness version recorded in the file itself, when it has one. */
  readonly harnessVersion?: string;
  /** Cumulative UTF-8 bytes of lines accepted by the server. */
  readonly uploadedBytes?: number;
}

export interface Session {
  readonly id: string;
  readonly stream: string;
}

export interface UploadOptions {
  /** State directory. Defaults to `$TRACES_HOME` or `~/.traces`. */
  readonly home?: string;
  readonly env?: Env;
  /** Overrides `TRACES_HARNESS_VERSION`, the file, and `<harness> --version`. */
  readonly harnessVersion?: string;
  /** Waits between attempts after a network error, 429, or 5xx. One retry per entry. */
  readonly retryDelaysMs?: ReadonlyArray<number>;
  readonly lockTimeoutMs?: number;
  readonly lockPollMs?: number;
  /** Per-request timeout. A batch that times out is split; a single entry is retried. */
  readonly requestTimeoutMs?: number;
}

export type Outcome =
  | "uploaded"
  | "unchanged"
  | "missing"
  | "locked"
  | "failed"
  | "unauthorized"
  | "unconfigured";

export interface FileResult {
  readonly outcome: Outcome;
  /** Entries the server accepted. */
  readonly sent: number;
  /** Entries the server reported as new. */
  readonly inserted: number;
  /** Blank, invalid, oversize, or rejected lines passed over. */
  readonly skipped: number;
}

// ---------------------------------------------------------------------------
// Paths, config, logs

export const tracesHome = (env: Env = process.env): string =>
  env.TRACES_HOME || join(homedir(), ".traces");

const ensureDir = (path: string) => mkdirSync(path, { recursive: true, mode: 0o700 });

const writeAtomic = (path: string, data: string, mode = 0o600) => {
  ensureDir(dirname(path));
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, data, { mode });
  try {
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
};

const readJson = (path: string): unknown => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

export const readConfig = (home: string): Config | undefined => {
  const raw = readJson(join(home, "config.json"));
  if (!isRecord(raw)) return undefined;
  const url = nonEmptyString(raw.url);
  const token = nonEmptyString(raw.token);
  const uploaderId = nonEmptyString(raw.uploaderId);
  if (!url || !token || !uploaderId || !isAllowedUrl(url)) return undefined;
  return { url, token, uploaderId };
};

/** HTTPS, or plain HTTP to this machine only, so a token is never sent in clear. */
export const isAllowedUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
};

const appendLog = (home: string, name: string, message: string) => {
  try {
    ensureDir(home);
    const path = join(home, name);
    try {
      if (statSync(path).size > LOG_MAX_BYTES) renameSync(path, `${path}.1`);
    } catch {
      // No log yet.
    }
    appendFileSync(path, `${new Date().toISOString()} ${message}\n`, { mode: 0o600 });
  } catch {
    // Logging must never break an upload.
  }
};

const uploadLog = (home: string, message: string) => appendLog(home, "upload.log", message);

// ---------------------------------------------------------------------------
// Sessions and metadata

const stem = (path: string) => basename(path).replace(/\.jsonl$/i, "");

/** The session a transcript belongs to, and the stream within it (a subagent, say). */
export const deriveSession = (harness: Harness, path: string): Session => {
  const name = stem(path);
  if (harness === "claude-code") {
    // <projects>/<project>/<session>/subagents/agent-<id>.jsonl
    const parent = dirname(path);
    if (basename(parent) === "subagents") {
      const session = basename(dirname(parent));
      if (session) return { id: session, stream: name };
    }
    return { id: name, stream: name };
  }
  if (harness === "omp" && !UUID_AT_END.test(name)) {
    // <sessions>/<project>/<timestamp>_<uuid>.jsonl, and a subagent's transcript in
    // the session's artifacts directory: <timestamp>_<uuid>/<Agent>.jsonl, possibly
    // nested under another subagent's (<timestamp>_<uuid>/<Agent>/<Sub>.jsonl).
    const parts: Array<string> = [name];
    for (let dir = dirname(path); dir !== dirname(dir); dir = dirname(dir)) {
      const session = UUID_AT_END.exec(basename(dir))?.[1];
      if (session) return { id: session, stream: parts.join("/") };
      parts.unshift(basename(dir));
    }
  }
  // codex: rollout-<timestamp>-<uuid>.jsonl; pi, omp: <timestamp>_<uuid>.jsonl
  const uuid = UUID_AT_END.exec(name)?.[1];
  const id = uuid ?? name;
  return { id, stream: id };
};

/** The cwd and harness version a transcript line records, if any. */
export const extractMetadata = (
  harness: Harness,
  raw: unknown,
): { cwd?: string; harnessVersion?: string } => {
  if (!isRecord(raw)) return {};
  switch (harness) {
    case "claude-code":
      return { cwd: nonEmptyString(raw.cwd), harnessVersion: nonEmptyString(raw.version) };
    case "codex": {
      if (raw.type !== "session_meta" || !isRecord(raw.payload)) return {};
      return {
        cwd: nonEmptyString(raw.payload.cwd),
        harnessVersion: nonEmptyString(raw.payload.cli_version),
      };
    }
    case "pi":
    case "omp":
      // The header's `version` is the session format, not Pi's version.
      return raw.type === "session" ? { cwd: nonEmptyString(raw.cwd) } : {};
  }
};

const VERSION_BINARIES: Record<Harness, string> = {
  "claude-code": "claude",
  codex: "codex",
  pi: "pi",
  omp: "omp",
};

/** `<harness> --version`, cached for a day, including "not installed". */
const installedVersion = (home: string, harness: Harness): string | undefined => {
  const path = join(home, "state", "versions.json");
  const cache = readJson(path);
  const cached = isRecord(cache) ? cache[harness] : undefined;
  if (
    isRecord(cached) &&
    typeof cached.checkedAt === "number" &&
    Date.now() - cached.checkedAt < VERSION_CACHE_MS
  ) {
    return nonEmptyString(cached.version);
  }
  let version: string | undefined;
  try {
    const output = execFileSync(VERSION_BINARIES[harness], ["--version"], {
      encoding: "utf8",
      timeout: VERSION_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
    });
    version = /\d+\.\d+\.\d+[^\s]*/.exec(output)?.[0];
  } catch {
    version = undefined;
  }
  try {
    writeAtomic(
      path,
      JSON.stringify({
        ...(isRecord(cache) ? cache : {}),
        [harness]: { version: version ?? null, checkedAt: Date.now() },
      }),
    );
  } catch {
    // An uncached lookup only costs another `--version` next time.
  }
  return version;
};

// ---------------------------------------------------------------------------
// Reading complete lines

interface Line {
  /** Byte offset of the line start. */
  readonly start: number;
  /** Byte offset just past its newline. */
  readonly end: number;
  /** UTF-8 bytes without the newline. */
  readonly length: number;
  /** Undefined when the line exceeds {@link MAX_LINE_BYTES}. */
  readonly bytes: Buffer | undefined;
}

/** Complete (newline-terminated) lines in `[from, to)`. A trailing partial line is not yielded. */
function* completeLines(fd: number, from: number, to: number): Generator<Line> {
  const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
  let position = from;
  let lineStart = from;
  let parts: Array<Buffer> = [];
  let pending = 0;
  let oversize = false;
  while (position < to) {
    const read = readSync(fd, buffer, 0, Math.min(READ_CHUNK_BYTES, to - position), position);
    if (read <= 0) return;
    const chunk = buffer.subarray(0, read);
    let index = 0;
    while (index < read) {
      const newline = chunk.indexOf(10, index);
      if (newline === -1) {
        const piece = read - index;
        if (!oversize && pending + piece > MAX_LINE_BYTES) {
          oversize = true;
          parts = [];
        }
        if (!oversize) parts.push(Buffer.from(chunk.subarray(index)));
        pending += piece;
        break;
      }
      const length = pending + (newline - index);
      const bytes =
        oversize || length > MAX_LINE_BYTES
          ? undefined
          : Buffer.concat([...parts, chunk.subarray(index, newline)]);
      const end = lineStart + length + 1;
      yield { start: lineStart, end, length, bytes };
      lineStart = end;
      parts = [];
      pending = 0;
      oversize = false;
      index = newline + 1;
    }
    position += read;
  }
}

/**
 * omp keeps a fixed-size title slot (`{"type":"title",...,"pad":"   "}`) on the first
 * line and overwrites it in place whenever the title changes.
 */
const OMP_TITLE_SLOT = Buffer.from('{"type":"title"');

/** Byte offset of the line that identifies the file: past omp's mutable title slot. */
const headStart = (harness: Harness, fd: number, size: number): number | undefined => {
  if (harness !== "omp") return 0;
  const prefix = Buffer.alloc(OMP_TITLE_SLOT.length);
  const read = readSync(fd, prefix, 0, Math.min(prefix.length, size), 0);
  if (read < prefix.length || !prefix.equals(OMP_TITLE_SLOT)) return 0;
  for (const line of completeLines(fd, 0, size)) return line.end;
  return undefined;
};

/**
 * SHA-256 of the file's identifying first line, or undefined while the file has no
 * complete one.
 */
const firstLineHash = (harness: Harness, fd: number, size: number): string | undefined => {
  const start = headStart(harness, fd, size);
  if (start === undefined) return undefined;
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let position = start;
  while (position < size) {
    const read = readSync(fd, buffer, 0, Math.min(buffer.length, size - position), position);
    if (read <= 0) return undefined;
    const chunk = buffer.subarray(0, read);
    const newline = chunk.indexOf(10);
    if (newline !== -1) {
      hash.update(chunk.subarray(0, newline));
      return hash.digest("hex");
    }
    hash.update(chunk);
    position += read;
  }
  return undefined;
};

const parseLine = (bytes: Buffer): { ok: true; raw: unknown } | { ok: false } => {
  const text = utf8.decode(bytes);
  if (text.trim() === "") return { ok: false };
  try {
    return { ok: true, raw: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
};

/** Looks through the start of a file for the cwd and harness version. */
const scanMetadata = (harness: Harness, fd: number, size: number) => {
  let cwd: string | undefined;
  let harnessVersion: string | undefined;
  let lines = 0;
  for (const line of completeLines(fd, 0, Math.min(size, METADATA_SCAN_BYTES))) {
    if (++lines > METADATA_SCAN_LINES) break;
    if (!line.bytes) continue;
    const parsed = parseLine(line.bytes);
    if (!parsed.ok) continue;
    const found = extractMetadata(harness, parsed.raw);
    cwd ??= found.cwd;
    harnessVersion ??= found.harnessVersion;
    if (cwd && harnessVersion) break;
  }
  return { cwd, harnessVersion };
};

// ---------------------------------------------------------------------------
// Cursors and locks

/** The file's real path, so a symlinked spelling of it shares one cursor. */
const canonicalPath = (file: string) => {
  try {
    return realpathSync(resolve(file));
  } catch {
    return resolve(file);
  }
};

const fileDigest = (file: string) =>
  createHash("sha256").update(canonicalPath(file)).digest("hex").slice(0, 32);

export const cursorPathFor = (home: string, harness: Harness, file: string): string =>
  join(home, "state", harness, `${fileDigest(file)}.json`);

/** Marks a file whose last upload failed or was locked out; holds its absolute path. */
export const pendingPathFor = (home: string, harness: Harness, file: string): string =>
  join(home, "state", "pending", harness, fileDigest(file));

/** Absolute paths of the harness's files awaiting a retry. */
export const pendingFiles = (home: string, harness: Harness): Array<string> => {
  const dir = join(home, "state", "pending", harness);
  let names: Array<string>;
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    if (!/^[0-9a-f]{32}$/.test(name)) return [];
    try {
      const path = readFileSync(join(dir, name), "utf8").trim();
      return isAbsolute(path) ? [path] : [];
    } catch {
      return [];
    }
  });
};

const readCursor = (path: string, file: string): Cursor => {
  const raw = readJson(path);
  if (!isRecord(raw) || typeof raw.offset !== "number" || raw.offset < 0) {
    return { path: file, offset: 0 };
  }
  return {
    path: file,
    offset: raw.offset,
    head: nonEmptyString(raw.head),
    cwd: nonEmptyString(raw.cwd),
    harnessVersion: nonEmptyString(raw.harnessVersion),
    uploadedBytes: typeof raw.uploadedBytes === "number" ? raw.uploadedBytes : 0,
  };
};

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** Whether a lock was left behind: older than 10 minutes, or its process on this host died. */
const isStale = (lock: string) => {
  try {
    if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) return true;
  } catch {
    return false;
  }
  const owner = readJson(join(lock, "owner.json"));
  return (
    isRecord(owner) &&
    owner.host === hostname() &&
    typeof owner.pid === "number" &&
    !isAlive(owner.pid)
  );
};

/**
 * `mkdir` is atomic, so the directory is the lock. Waits for a holder rather than
 * skipping, because the caller already runs in the background and must not drop a delta.
 */
const acquireLock = async (
  lock: string,
  timeoutMs: number,
  pollMs: number,
): Promise<(() => void) | undefined> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      mkdirSync(lock, { mode: 0o700 });
      try {
        writeFileSync(
          join(lock, "owner.json"),
          JSON.stringify({ pid: process.pid, host: hostname() }),
        );
      } catch {
        // Without an owner file, only age marks the lock stale.
      }
      return () => rmSync(lock, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (isStale(lock)) {
      // Rename first so only one waiter removes a given stale lock.
      const tombstone = `${lock}.${process.pid}.${randomUUID()}.stale`;
      try {
        renameSync(lock, tombstone);
        rmSync(tombstone, { recursive: true, force: true });
      } catch {
        // Another waiter got there first.
      }
      continue;
    }
    if (Date.now() >= deadline) return undefined;
    await sleep(pollMs);
  }
};

// ---------------------------------------------------------------------------
// Sending

interface Entry {
  readonly offset: number;
  readonly raw: unknown;
  readonly length: number;
}

interface Batch {
  readonly client: Record<string, string>;
  readonly session: Record<string, string>;
}

type SendResult =
  | {
      readonly ok: true;
      readonly sent: number;
      readonly inserted: number;
      readonly skipped: number;
    }
  | { readonly ok: false; readonly reason: "unauthorized" | "failed" };

interface Sender {
  readonly config: Config;
  readonly home: string;
  readonly file: string;
  readonly retryDelaysMs: ReadonlyArray<number>;
  readonly requestTimeoutMs: number;
}

type PostResult =
  | { readonly kind: "response"; readonly status: number; readonly body: unknown }
  | { readonly kind: "timeout" }
  | { readonly kind: "network" };

const post = async (
  sender: Sender,
  batch: Batch,
  entries: ReadonlyArray<Entry>,
): Promise<PostResult> => {
  const signal = AbortSignal.timeout(sender.requestTimeoutMs);
  try {
    const response = await fetch(new URL("/api/ingest", sender.config.url), {
      method: "POST",
      headers: {
        authorization: `Bearer ${sender.config.token}`,
        "content-type": "application/json",
        "user-agent": USER_AGENT,
      },
      body: JSON.stringify({
        ...batch,
        entries: entries.map(({ offset, raw }) => ({ offset, raw })),
      }),
      // Never follow a redirect with the bearer token.
      redirect: "error",
      signal,
    });
    const text = await response.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    return { kind: "response", status: response.status, body };
  } catch {
    return signal.aborted ? { kind: "timeout" } : { kind: "network" };
  }
};

const isRetryable = (posted: PostResult) =>
  posted.kind !== "response" || posted.status === 429 || posted.status >= 500;

const describe = (posted: PostResult) => (posted.kind === "response" ? posted.status : posted.kind);

/** Sends the halves in order; the first failure stops the rest. */
const sendHalves = async (
  sender: Sender,
  batch: Batch,
  entries: ReadonlyArray<Entry>,
): Promise<SendResult> => {
  const middle = Math.ceil(entries.length / 2);
  const first = await send(sender, batch, entries.slice(0, middle));
  if (!first.ok) return first;
  const second = await send(sender, batch, entries.slice(middle));
  if (!second.ok) return second;
  return {
    ok: true,
    sent: first.sent + second.sent,
    inserted: first.inserted + second.inserted,
    skipped: first.skipped + second.skipped,
  };
};

/**
 * Posts entries. Network errors, 429, and 5xx are retried. A batch that times out
 * or is too large (413) is split; a single entry that is too large is skipped, but
 * one that times out is an ordinary failure. Every other outcome, including a 2xx
 * that doesn't confirm every entry, fails and leaves the cursor in place.
 */
const send = async (
  sender: Sender,
  batch: Batch,
  entries: ReadonlyArray<Entry>,
): Promise<SendResult> => {
  const name = basename(sender.file);
  let posted: PostResult;
  for (let attempt = 0; ; attempt++) {
    posted = await post(sender, batch, entries);
    if (posted.kind === "timeout" && entries.length > 1) {
      uploadLog(sender.home, `timed out; splitting batch entries=${entries.length} file=${name}`);
      return sendHalves(sender, batch, entries);
    }
    if (!isRetryable(posted)) break;
    const delay = sender.retryDelaysMs[attempt];
    if (delay === undefined) {
      uploadLog(
        sender.home,
        `upload failed status=${describe(posted)} attempts=${attempt + 1} file=${name}`,
      );
      return { ok: false, reason: "failed" };
    }
    await sleep(delay);
  }
  if (posted.kind !== "response") return { ok: false, reason: "failed" };
  const { status, body } = posted;
  if (status >= 200 && status < 300) {
    if (!isRecord(body) || body.received !== entries.length) {
      uploadLog(sender.home, `upload failed status=${status} unconfirmed entries file=${name}`);
      return { ok: false, reason: "failed" };
    }
    const inserted = typeof body.inserted === "number" ? body.inserted : 0;
    return { ok: true, sent: entries.length, inserted, skipped: 0 };
  }
  if (status === 401 || status === 403) {
    uploadLog(sender.home, `token rejected; re-run login status=${status}`);
    return { ok: false, reason: "unauthorized" };
  }
  if (status === 413) {
    if (entries.length > 1) return sendHalves(sender, batch, entries);
    uploadLog(
      sender.home,
      `skipped rejected entry offset=${entries[0]?.offset} status=${status} file=${name}`,
    );
    return { ok: true, sent: 0, inserted: 0, skipped: 1 };
  }
  // 400 and 422 reject the envelope, not one entry; skipping would drop the transcript.
  uploadLog(sender.home, `upload rejected status=${status} file=${name}`);
  return { ok: false, reason: "failed" };
};

const clientInfo = (harness: Harness, harnessVersion: string | undefined) => {
  const host = hostname();
  const platform = process.platform && process.arch ? `${process.platform}-${process.arch}` : "";
  return {
    harness,
    ...(harnessVersion ? { harnessVersion } : {}),
    uploaderVersion: UPLOADER_VERSION,
    ...(host ? { host } : {}),
    ...(platform ? { platform } : {}),
  };
};

// ---------------------------------------------------------------------------
// Upload

const result = (outcome: Outcome, sent = 0, inserted = 0, skipped = 0): FileResult => ({
  outcome,
  sent,
  inserted,
  skipped,
});

/**
 * Uploads the complete lines a JSONL transcript gained since the last upload. The
 * cursor advances only after the server accepts a batch, so a failure resends the
 * same lines next time; the server dedups them. A file that fails or can't get its
 * lock is recorded as pending, and every later `upload` for the harness retries it,
 * because hooks only name the current session and the last turn may never repeat.
 */
export const uploadFile = async (
  harness: Harness,
  file: string,
  options: UploadOptions = {},
): Promise<FileResult> => {
  const home = options.home ?? tracesHome(options.env ?? process.env);
  const outcome = await uploadOnce(harness, file, options);
  const marker = pendingPathFor(home, harness, file);
  try {
    switch (outcome.outcome) {
      case "failed":
      case "locked":
        writeAtomic(marker, resolve(file));
        break;
      case "uploaded":
      case "unchanged":
      case "missing":
        rmSync(marker, { force: true });
        break;
      default:
        break;
    }
  } catch {
    uploadLog(home, `could not update pending file=${basename(file)}`);
  }
  return outcome;
};

const uploadOnce = async (
  harness: Harness,
  file: string,
  options: UploadOptions = {},
): Promise<FileResult> => {
  const env = options.env ?? process.env;
  const home = options.home ?? tracesHome(env);
  const config = readConfig(home);
  if (!config) {
    uploadLog(home, "not logged in; run login");
    return result("unconfigured");
  }
  // Sessions derive from the harness's own layout; the cursor follows the real file.
  const path = resolve(file);
  const name = basename(path);
  const cursorPath = cursorPathFor(home, harness, path);
  ensureDir(dirname(cursorPath));
  const release = await acquireLock(
    `${cursorPath}.lock`,
    options.lockTimeoutMs ?? LOCK_TIMEOUT_MS,
    options.lockPollMs ?? LOCK_POLL_MS,
  );
  if (!release) {
    uploadLog(home, `lock busy; queued as pending for the next upload file=${name}`);
    return result("locked");
  }
  let fd: number | undefined;
  try {
    try {
      fd = openSync(path, "r");
    } catch {
      uploadLog(home, `missing file=${name}`);
      return result("missing");
    }
    const size = fstatSync(fd).size;
    const head = firstLineHash(harness, fd, size);
    if (head === undefined) return result("unchanged");
    const real = canonicalPath(path);
    let cursor = readCursor(cursorPath, real);
    if (cursor.head !== head || size < cursor.offset) {
      if (cursor.head !== undefined) uploadLog(home, `rewritten; restarting file=${name}`);
      cursor = { path: real, offset: 0, head, uploadedBytes: cursor.uploadedBytes ?? 0 };
    }
    if (cursor.offset >= size) return result("unchanged");
    if (cursor.cwd === undefined) {
      const found = scanMetadata(harness, fd, size);
      cursor = {
        ...cursor,
        ...(found.cwd ? { cwd: found.cwd } : {}),
        ...(found.harnessVersion ? { harnessVersion: found.harnessVersion } : {}),
      };
    }
    const harnessVersion =
      options.harnessVersion ??
      nonEmptyString(env.TRACES_HARNESS_VERSION) ??
      cursor.harnessVersion ??
      installedVersion(home, harness);
    const session = deriveSession(harness, path);
    const batch: Batch = {
      client: clientInfo(harness, harnessVersion),
      session: {
        id: session.id,
        stream: session.stream,
        ...(cursor.cwd ? { cwd: cursor.cwd } : {}),
      },
    };
    const sender: Sender = {
      config,
      home,
      file: path,
      retryDelaysMs: options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS,
      requestTimeoutMs: options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
    };

    let sent = 0;
    let inserted = 0;
    let skipped = 0;
    let entries: Array<Entry> = [];
    let bytes = 0;
    // End of the last line examined, including skipped ones.
    let consumed = cursor.offset;

    const flush = async (): Promise<SendResult> => {
      const outcome =
        entries.length > 0
          ? await send(sender, batch, entries)
          : ({ ok: true, sent: 0, inserted: 0, skipped: 0 } as const);
      if (!outcome.ok) return outcome;
      sent += outcome.sent;
      inserted += outcome.inserted;
      skipped += outcome.skipped;
      const accepted = outcome.skipped === 0 ? bytes : sentBytes(entries, outcome);
      cursor = {
        ...cursor,
        offset: consumed,
        uploadedBytes: (cursor.uploadedBytes ?? 0) + accepted,
      };
      writeAtomic(cursorPath, JSON.stringify(cursor));
      entries = [];
      bytes = 0;
      return outcome;
    };

    for (const line of completeLines(fd, cursor.offset, size)) {
      if (!line.bytes) {
        uploadLog(
          home,
          `skipped oversize entry offset=${line.start} bytes=${line.length} file=${name}`,
        );
        skipped++;
        consumed = line.end;
        continue;
      }
      const parsed = parseLine(line.bytes);
      if (!parsed.ok) {
        if (utf8.decode(line.bytes).trim() !== "") {
          uploadLog(home, `skipped invalid JSON offset=${line.start} file=${name}`);
          skipped++;
        }
        consumed = line.end;
        continue;
      }
      if (entries.length > 0 && bytes + line.length > MAX_BATCH_BYTES) {
        const outcome = await flush();
        if (!outcome.ok) return result(outcome.reason, sent, inserted, skipped);
      }
      entries.push({ offset: line.start, raw: parsed.raw, length: line.length });
      bytes += line.length;
      consumed = line.end;
      if (entries.length >= MAX_BATCH_ENTRIES) {
        const outcome = await flush();
        if (!outcome.ok) return result(outcome.reason, sent, inserted, skipped);
      }
    }
    if (entries.length > 0 || consumed > cursor.offset) {
      const outcome = await flush();
      if (!outcome.ok) return result(outcome.reason, sent, inserted, skipped);
    }
    return result(sent > 0 ? "uploaded" : "unchanged", sent, inserted, skipped);
  } finally {
    if (fd !== undefined) closeSync(fd);
    release();
  }
};

// Rejected single entries aren't counted toward uploaded bytes. Approximate when a
// split batch skipped some: proportional share is good enough for `status`.
const sentBytes = (
  entries: ReadonlyArray<Entry>,
  outcome: { readonly sent: number; readonly skipped: number },
) => {
  const total = entries.reduce((sum, entry) => sum + entry.length, 0);
  return Math.round((total * outcome.sent) / Math.max(1, outcome.sent + outcome.skipped));
};

// ---------------------------------------------------------------------------
// Session discovery

const harnessRoots = (harness: Harness, env: Env): Array<string> => {
  const home = homedir();
  switch (harness) {
    case "claude-code":
      return [join(env.CLAUDE_CONFIG_DIR || join(home, ".claude"), "projects")];
    case "codex": {
      const codex = env.CODEX_HOME || join(home, ".codex");
      return [join(codex, "sessions"), join(codex, "archived_sessions")];
    }
    case "pi":
      return [join(env.PI_CODING_AGENT_DIR || join(home, ".pi", "agent"), "sessions")];
    case "omp":
      // omp also honors PI_CODING_AGENT_DIR, but a set one most likely points at pi's.
      return [join(home, ".omp", "agent", "sessions")];
  }
};

/** Every session file for a harness, newest first. */
export const listSessionFiles = (
  harness: Harness,
  env: Env = process.env,
): Array<{ path: string; mtimeMs: number }> => {
  const files: Array<{ path: string; mtimeMs: number }> = [];
  for (const root of harnessRoots(harness, env)) {
    let names: Array<string>;
    try {
      names = readdirSync(root, { recursive: true, encoding: "utf8" });
    } catch {
      continue;
    }
    for (const relative of names) {
      if (!relative.endsWith(".jsonl")) continue;
      const path = join(root, relative);
      try {
        const stats = statSync(path);
        if (stats.isFile()) files.push({ path, mtimeMs: stats.mtimeMs });
      } catch {
        // Removed while listing.
      }
    }
  }
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs);
};

// ---------------------------------------------------------------------------
// Commands

const isHarness = (value: string | undefined): value is Harness =>
  HARNESSES.some((harness) => harness === value);

const usage = `usage:
  traces login --url <origin> --code <claim code>
  traces hook <claude-code|codex>
  traces upload <claude-code|codex|pi|omp> <file...> [--harness-version <version>]
  traces sync <claude-code|codex|pi|omp|all>
  traces status`;

const flag = (args: Array<string>, name: string): string | undefined => {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  args.splice(index, 2);
  return value;
};

const login = async (args: Array<string>, home: string): Promise<number> => {
  const url = flag(args, "--url");
  const code = flag(args, "--code");
  if (!url || !code) {
    console.error(usage);
    return 2;
  }
  if (!isAllowedUrl(url)) {
    console.error("login failed: the URL must use https (http is allowed only for localhost)");
    return 1;
  }
  const origin = new URL(url).origin;
  let response: Response;
  try {
    response = await fetch(new URL("/api/uploaders/claim", origin), {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": USER_AGENT },
      body: JSON.stringify({ code }),
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    console.error(`login failed: could not reach ${origin} (redirects are not followed)`);
    return 1;
  }
  if (response.status === 401) {
    console.error("claim code invalid or expired");
    return 1;
  }
  if (!response.ok) {
    console.error(`login failed: HTTP ${response.status}`);
    return 1;
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  const uploaderId = isRecord(body) ? nonEmptyString(body.uploaderId) : undefined;
  const token = isRecord(body) ? nonEmptyString(body.token) : undefined;
  if (!uploaderId || !token) {
    console.error("login failed: unexpected response from the server");
    return 1;
  }
  ensureDir(home);
  chmodSync(home, 0o700);
  writeAtomic(join(home, "config.json"), JSON.stringify({ url: origin, token, uploaderId }));
  console.log(`Logged in as uploader ${uploaderId}`);
  return 0;
};

const readStdin = async (timeoutMs: number): Promise<string> => {
  const chunks: Array<Buffer> = [];
  const read = (async () => {
    for await (const chunk of process.stdin) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
  })();
  await Promise.race([read, sleep(timeoutMs)]);
  return utf8.decode(Buffer.concat(chunks));
};

/**
 * Transcript paths in a hook payload: Stop carries `transcript_path`, SubagentStop
 * also `agent_transcript_path`. A leading `~/` is expanded; anything still relative
 * is ignored.
 */
export const transcriptPaths = (
  input: Record<string, unknown>,
  home: string = homedir(),
): Array<string> => {
  const paths: Array<string> = [];
  for (const value of [input.transcript_path, input.agent_transcript_path]) {
    if (typeof value !== "string") continue;
    const path = value.startsWith("~/") ? join(home, value.slice(2)) : value;
    if (isAbsolute(path) && !paths.includes(path)) paths.push(path);
  }
  return paths;
};

/** Never writes to stdout and always exits 0, so it can't change the agent's behavior. */
const hook = async (args: Array<string>, home: string): Promise<number> => {
  try {
    const harness = args[0];
    if (harness !== "claude-code" && harness !== "codex") {
      uploadLog(home, "hook: unknown harness");
      return 0;
    }
    const input: unknown = JSON.parse(await readStdin(5000));
    if (!isRecord(input)) return 0;
    if (!readConfig(home)) {
      uploadLog(home, "hook: not logged in; run login");
      return 0;
    }
    const paths = transcriptPaths(input);
    if (paths.length === 0) return 0;
    const child = spawn(
      process.execPath,
      [...process.execArgv, fileURLToPath(import.meta.url), "upload", harness, ...paths],
      { detached: true, stdio: "ignore", env: process.env },
    );
    child.on("error", () => uploadLog(home, "hook: could not start the background upload"));
    child.unref();
  } catch {
    uploadLog(home, "hook: unreadable hook input");
  }
  return 0;
};

const upload = async (args: Array<string>, home: string): Promise<number> => {
  const harnessVersion = flag(args, "--harness-version");
  const [harness, ...files] = args;
  if (!isHarness(harness) || files.length === 0) {
    console.error(usage);
    return 2;
  }
  let sent = 0;
  let skipped = 0;
  // The named files first, then every earlier failure for this harness.
  const queue = [...files];
  const seen = new Set<string>();
  for (let index = 0; index < queue.length; index++) {
    const file = queue[index];
    if (file === undefined) continue;
    const key = cursorPathFor(home, harness, file);
    if (seen.has(key)) continue;
    seen.add(key);
    // A pending file may be another session, so the given version doesn't apply.
    const named = index < files.length;
    const outcome = await uploadFile(harness, file, {
      home,
      ...(harnessVersion && named ? { harnessVersion } : {}),
    });
    if (index === files.length - 1) queue.push(...pendingFiles(home, harness));
    sent += outcome.sent;
    skipped += outcome.skipped;
    if (outcome.outcome === "unconfigured") {
      console.error("not logged in; run login first");
      return 1;
    }
    if (outcome.outcome === "unauthorized") {
      console.error("token rejected; re-run login");
      return 1;
    }
  }
  console.error(`uploaded ${sent} entries, skipped ${skipped}`);
  return 0;
};

const sync = async (args: Array<string>, home: string): Promise<number> => {
  const target = args[0];
  const harnesses: ReadonlyArray<Harness> =
    target === "all" ? HARNESSES : isHarness(target) ? [target] : [];
  if (harnesses.length === 0) {
    console.error(usage);
    return 2;
  }
  if (!readConfig(home)) {
    console.error("not logged in; run login first");
    return 1;
  }
  const progress = (message: string) => {
    console.error(message);
    appendLog(home, "sync.log", message);
  };
  const files = harnesses
    .flatMap((harness) => listSessionFiles(harness).map((file) => ({ harness, ...file })))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  progress(`sync ${target}: ${files.length} files`);
  let sent = 0;
  let skipped = 0;
  let failed = 0;
  for (const [index, file] of files.entries()) {
    const outcome = await uploadFile(file.harness, file.path, { home });
    sent += outcome.sent;
    skipped += outcome.skipped;
    if (outcome.outcome === "failed" || outcome.outcome === "locked") failed++;
    if (outcome.outcome === "unauthorized" || outcome.outcome === "unconfigured") {
      progress(`sync stopped: token rejected; re-run login`);
      return 1;
    }
    progress(
      `sync ${index + 1}/${files.length} ${file.harness} ${basename(file.path)} ${outcome.outcome}: entries sent=${sent} skipped=${skipped} failed files=${failed}`,
    );
  }
  progress(
    `sync ${target} done: ${files.length} files, entries sent=${sent} skipped=${skipped} failed files=${failed}`,
  );
  return 0;
};

const status = (home: string): number => {
  const config = readConfig(home);
  if (!config) {
    console.log("not logged in");
    return 1;
  }
  console.log(`url: ${config.url}`);
  console.log(`uploader: ${config.uploaderId}`);
  let bytes = 0;
  for (const harness of HARNESSES) {
    let tracked = 0;
    let names: Array<string> = [];
    try {
      names = readdirSync(join(home, "state", harness));
    } catch {
      // Nothing uploaded for this harness yet.
    }
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      tracked++;
      const cursor = readJson(join(home, "state", harness, name));
      if (isRecord(cursor) && typeof cursor.uploadedBytes === "number") {
        bytes += cursor.uploadedBytes;
      }
    }
    const pending = pendingFiles(home, harness).length;
    console.log(`${harness}: ${tracked} files tracked${pending ? `, ${pending} pending` : ""}`);
  }
  console.log(`uploaded: ${bytes} bytes`);
  return 0;
};

export const main = async (argv: ReadonlyArray<string>): Promise<number> => {
  const [command, ...args] = argv;
  const home = tracesHome();
  switch (command) {
    case "login":
      return login(args, home);
    case "hook":
      return hook(args, home);
    case "upload":
      return upload(args, home);
    case "sync":
      return sync(args, home);
    case "status":
      return status(home);
    default:
      console.error(usage);
      return 2;
  }
};

const isEntryPoint = () => {
  try {
    const script = process.argv[1];
    return (
      script !== undefined && realpathSync(script) === realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
};

if (isEntryPoint()) {
  const command = process.argv[2];
  main(process.argv.slice(2)).then(
    (code) => process.exit(command === "hook" ? 0 : code),
    () => {
      if (command !== "hook") console.error("traces: unexpected failure");
      process.exit(command === "hook" ? 0 : 1);
    },
  );
}
