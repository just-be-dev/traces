import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { type ManifestEntry, SKILL_NAME, skillManifest, skillUri } from "./skill.ts";

export class InstallAddress extends Context.Service<
  InstallAddress,
  {
    readonly apiUrl: Effect.Effect<string>;
    /** The public hostname's origin, e.g. `https://traces.just-be.dev`, when one is configured. */
    readonly publicOrigin: Option.Option<string>;
  }
>()("traces/InstallAddress") {}

/** Where an `/install` request arrived. */
export interface InstallRequest {
  /** Scheme, host, and port the request was addressed to. */
  readonly origin: string;
  /**
   * The request came through a router that mounts the Website under a path, such as
   * `https://just-be.dev/traces`. The uploader only talks to an origin's root, so
   * the guide points those agents at the public origin instead.
   */
  readonly mounted: boolean;
}

/**
 * The public `/install` page. `ORIGIN` is where the page was requested from: the
 * Website, which forwards `/install` and `/api/*` to the API Worker without Access.
 * Downloads and uploads go there; the MCP endpoint is on the API Worker behind Access.
 */
export const readInstallGuide = Effect.fn("Install.read")(function* (request: InstallRequest) {
  const address = yield* InstallAddress;
  return installGuide({
    origin: request.mounted
      ? Option.getOrElse(address.publicOrigin, () => request.origin)
      : request.origin,
    apiUrl: yield* address.apiUrl,
    manifest: yield* skillManifest(),
  });
});

export const installGuide = (options: {
  /** Scheme, host, and port, e.g. `https://traces.example.workers.dev`. */
  readonly origin: string;
  readonly apiUrl: string;
  readonly manifest: ReadonlyArray<ManifestEntry>;
}) => {
  const origin = options.origin.replace(/\/+$/, "");
  const mcpUrl = new URL("/mcp", options.apiUrl).href;
  const files = options.manifest
    .map(
      (file) =>
        `| \`${file.path}\` | ${origin}/install/skills/${SKILL_NAME}/${file.path} | \`${file.sha256}\` | ${file.size} |`,
    )
    .join("\n");
  return `# Install Traces

You are a coding agent setting up trace uploads for the user on this machine. Traces stores the user's agent session transcripts so they can search them later. At the end of every turn, a hook uploads the new part of the session transcript. A one-time background sync then uploads past sessions.

- \`ORIGIN\` = \`${origin}\`. This public Website serves downloads and uploads.
- MCP server: \`${mcpUrl}\`. It's on the API Worker, signed in through Cloudflare Access OAuth.

Ask the user before changing any agent settings. Transcripts include prompts, tool inputs and results, and file contents, so get their explicit consent to upload them.

## 1. Identify your harness

Use the agent you're running in: \`claude-code\`, \`codex\`, or \`pi\`. Amp can connect the MCP server for search (step 2), but it has no verified turn hook, so stop after step 2 and say so.

## 2. Connect the \`traces\` MCP server

Check whether a server named \`traces\` already exists and points at this URL. If it does, skip to sign-in. Don't overwrite a different entry without asking.

- Claude Code: \`claude mcp add --transport http --scope user traces ${mcpUrl}\`, then sign in from \`/mcp\` in a session.
- Codex: \`codex mcp add traces --url ${mcpUrl}\`, then \`codex mcp login traces\`.
- pi: \`pi mcp add traces --url ${mcpUrl}\`, then \`pi mcp login traces\` (or \`/mcp login traces\` in a session, then \`/reload\`).
- Amp: \`amp mcp add traces ${mcpUrl}\`, then \`amp mcp oauth login traces\`.

Sign-in opens a browser for Cloudflare Access, so the user has to complete it. A running session may need a restart or reload before the new server's tools appear. If OAuth fails, report the error. Don't work around it with cookies or tokens.

Check that the server exposes the \`create_uploader\`, \`list_sessions\`, and \`search_traces\` tools.

## 3. Load the \`${SKILL_NAME}\` skill and follow it

The skill lives on the \`traces\` MCP server at \`${skillUri("SKILL.md")}\`.

- If your harness supports MCP skills (\`io.modelcontextprotocol/skills\`), load it from there.
- Otherwise, read it as an MCP resource: server \`traces\`, URI \`${skillUri("SKILL.md")}\`. Use \`read_mcp_resource\` in Codex and pi, or \`ReadMcpResourceTool\` in Claude Code. Read its references the same way, e.g. \`${skillUri("references/claude-code.md")}\`.
- As a last resort: \`curl -fsSL ${origin}/install/skills/${SKILL_NAME}/SKILL.md\`.

Follow the skill with \`ORIGIN=${origin}\`. It downloads the uploader, gets an upload credential from \`create_uploader\` (MCP sign-in is the only login), installs the turn-end hook for your harness, and starts the background backfill.

## Skill files

Download a file with \`curl -fsSL <URL> -o <path>\`, then check its SHA-256 before you use it.

| File | URL | SHA-256 | Bytes |
| --- | --- | --- | --- |
${files}
`;
};
