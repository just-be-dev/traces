import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

export class InstallAddress extends Context.Service<
  InstallAddress,
  { readonly apiUrl: Effect.Effect<string> }
>()("traces/InstallAddress") {}

export const installInstructions = (apiUrl: string) => {
  const mcpUrl = new URL("/mcp", apiUrl).href;
  const eventsUrl = new URL("/api/events", apiUrl).href;
  return `# Install Traces

These instructions are for a coding agent on the user's machine. Ask permission before editing agent settings or adding hooks. The MCP endpoint is on the **API Worker**, not the public Website. Do not send real prompts or tool results until the user has approved data retention and redaction.

## Connect the remote MCP

Check whether an entry named \`traces\` already exists. Do not overwrite it without review. Choose your agent's command and sign in as an allowed Cloudflare Access user. OAuth discovery and client compatibility are not yet production-tested.

- Amp local CLI: \`amp mcp add traces ${mcpUrl}\`, then \`amp mcp oauth login traces\`. For Amp cloud/orbs: \`amp mcp remote add traces ${mcpUrl} --auth oauth --personal\`, then \`amp mcp remote login traces --personal\`. Use a narrower project scope if appropriate; obtain approval before changing remote settings.
- Claude Code: \`claude mcp add --transport http --scope user traces ${mcpUrl}\`, then \`claude mcp login traces\`.
- Codex CLI: \`codex mcp add traces --url ${mcpUrl}\`, then \`codex mcp login traces\`.
- Pi: \`pi mcp add traces --url ${mcpUrl}\`, then \`pi mcp login traces\`.

Verify that \`search_traces\` and \`inspect_hooks\` appear in MCP tool discovery. Do not put Access service-token secrets in MCP settings or the repository. If OAuth fails, report the error rather than using a browser cookie as a workaround.

## Get and install optional hooks

Hooks submit sensitive native JSON to ${eventsUrl}. They do not reuse interactive MCP login: an unattended process needs a separately provisioned Cloudflare Access service token admitted by the deployment policy. No token is issued here. Get the bridge from the Amp-hosted repository using \`amp clone just-be/traces\` (or use an existing trusted checkout). Inspect \`scripts/submit-hook.ts\` before installing it. It requires Bun and reads JSON from stdin. Use an **absolute path** to that file in hook commands. Ask for approval before collecting raw prompts, tool inputs, or tool results.

Set \`TRACES_ENDPOINT=${apiUrl}\`, \`CF_ACCESS_CLIENT_ID\`, and \`CF_ACCESS_CLIENT_SECRET\` in the local agent process environment through an approved secret store. Do not write credentials in hook config, shell history, or a committed .env file. Send a synthetic event through the bridge first, check it through \`search_traces\`, then restart the agent after changing hooks.

### Claude Code

Inspect \`~/.claude/settings.json\` or \`.claude/settings.json\`. Merge this example into the existing \`hooks\` object; preserve existing entries and replace the path:

    {
      "hooks": {
        "PostToolUse": [{
          "hooks": [{"type": "command", "command": "bun /absolute/path/to/traces/scripts/submit-hook.ts claude-code", "timeout": 5}]
        }]
      }
    }

For more coverage, add the same command to \`SessionStart\`, \`UserPromptSubmit\`, \`Stop\`, and \`SessionEnd\`. Reference: https://code.claude.com/docs/en/hooks .

### Codex CLI

First confirm that the installed version supports command hooks. Inspect \`~/.codex/hooks.json\` or \`.codex/hooks.json\` and merge rather than replace entries. An example SessionStart hook:

    {
      "hooks": {
        "SessionStart": [{
          "hooks": [{"type": "command", "command": "bun /absolute/path/to/traces/scripts/submit-hook.ts codex"}]
        }]
      }
    }

Check the installed Codex hook schema and stdin payloads before adding more events. Legacy \`notify\` passes a CLI argument instead of JSON stdin and cannot use this bridge unchanged. Codex may require explicitly trusting new hooks. Reference: https://github.com/openai/codex/blob/main/codex-rs/exec/tests/suite/hooks.rs .

### Pi and Amp

Pi supports trusted TypeScript extensions under \`~/.pi/agent/extensions/\` or \`.pi/extensions/\`, but this repo does not yet ship a Pi capture extension; do not install this stdin bridge as one. Amp can use the MCP server, but no supported lifecycle hook for turn/tool capture has been verified. Do not claim either integration records traces. Pi reference: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md .

The current \`inspect_hooks\` tool and this page provide guidance, **not** a remote installer that can edit local files. Review the hook diff with the user, test one synthetic event, and revert only the entries you installed if needed. Cloudflare deployment and Access policy changes require separate approval.
`;
};
