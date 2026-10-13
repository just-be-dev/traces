// Traces capture for Pi. Install at ~/.pi/agent/extensions/traces.ts.
//
// At the end of each user turn (`agent_settled`) and when a session shuts down, it
// starts the Traces uploader in the background to send the lines the session file
// gained. The uploader (~/.traces/bin/traces.ts) holds the credentials, cursor, and
// lock, so this extension never reads tokens or session contents itself. It never
// throws out of a handler and never waits for the upload.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

// Minimal structural view of Pi's ExtensionAPI; the package isn't a dependency here.
interface SessionManagerLike {
  getSessionFile(): string | undefined;
}
interface ContextLike {
  readonly sessionManager?: SessionManagerLike;
}
interface PiLike {
  on(event: string, handler: (event: unknown, ctx: ContextLike) => unknown): unknown;
}

const DEBOUNCE_MS = 2000;

const tracesHome = () => process.env.TRACES_HOME || join(homedir(), ".traces");

/** Bun, or Node with default type stripping (>= 22.18, or >= 23.6), can run the `.ts` uploader. */
const runtime = (): string => {
  const exe = process.execPath;
  const name = basename(exe)
    .toLowerCase()
    .replace(/\.exe$/, "");
  if (name === "bun") return exe;
  if (name === "node") {
    const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
    if (major > 23 || (major === 23 && minor >= 6) || (major === 22 && minor >= 18)) return exe;
  }
  return "bun";
};

const sessionFile = (ctx: ContextLike): string | undefined => {
  try {
    const file = ctx.sessionManager?.getSessionFile();
    return typeof file === "string" && file.length > 0 ? file : undefined;
  } catch {
    return undefined;
  }
};

export default function traces(pi: PiLike): void {
  let version: string | undefined;
  let versionLookup: Promise<void> | undefined;
  const lastSpawn = new Map<string, number>();
  const pending = new Map<string, ReturnType<typeof setTimeout>>();

  const lookUpVersion = () => {
    versionLookup ??= (async () => {
      try {
        // Non-literal so bundlers and type checkers don't require the package.
        const specifier = ["@earendil-works", "pi-coding-agent"].join("/");
        const module: unknown = await import(specifier);
        const found =
          typeof module === "object" && module !== null && "VERSION" in module
            ? module.VERSION
            : undefined;
        if (typeof found === "string" && found.length > 0) version = found;
      } catch {
        // The uploader falls back to `pi --version`.
      }
    })();
  };

  const start = (file: string) => {
    try {
      const home = tracesHome();
      const script = join(home, "bin", "traces.ts");
      if (!existsSync(script) || !existsSync(join(home, "config.json")) || !existsSync(file)) {
        return;
      }
      lastSpawn.set(file, Date.now());
      const child = spawn(
        runtime(),
        [script, "upload", "pi", file, ...(version ? ["--harness-version", version] : [])],
        { detached: true, stdio: "ignore", env: process.env },
      );
      child.on("error", () => {});
      child.unref();
    } catch {
      // Capture is best effort; the next turn retries from the same cursor.
    }
  };

  /**
   * At most one start per file every 2 seconds; a request inside the window becomes
   * one trailing start. Shutdown starts immediately because Pi may exit before a timer.
   */
  const upload = (ctx: ContextLike, immediate: boolean) => {
    try {
      lookUpVersion();
      const file = sessionFile(ctx);
      if (!file) return;
      const timer = pending.get(file);
      if (immediate) {
        if (timer !== undefined) clearTimeout(timer);
        pending.delete(file);
        start(file);
        return;
      }
      if (timer !== undefined) return;
      const wait = (lastSpawn.get(file) ?? 0) + DEBOUNCE_MS - Date.now();
      if (wait <= 0) {
        start(file);
        return;
      }
      const trailing = setTimeout(() => {
        pending.delete(file);
        start(file);
      }, wait);
      // Don't keep Pi alive for a pending upload; shutdown uploads anyway.
      if (typeof trailing === "object" && trailing !== null && "unref" in trailing) {
        trailing.unref();
      }
      pending.set(file, trailing);
    } catch {
      // Never break the session over trace capture.
    }
  };

  pi.on("session_start", () => {
    lookUpVersion();
  });
  pi.on("agent_settled", (_event, ctx) => {
    upload(ctx, false);
  });
  pi.on("session_shutdown", (_event, ctx) => {
    upload(ctx, true);
  });
}
