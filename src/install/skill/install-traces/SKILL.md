---
name: install-traces
description: Install the Traces uploader and turn-end hooks for this coding agent (Claude Code, Codex, or pi), then backfill existing sessions. Use when the user asks to set up, install, repair, or uninstall trace uploads.
---

# Install Traces

This skill installs a small local uploader that sends this agent's session transcripts to the user's Traces server. At the end of every turn, a hook (or pi extension) uploads only the transcript lines added since the last upload. A one-time background sync then uploads every existing session.

**Get explicit consent first.** Transcripts contain everything: prompts, model output, tool inputs and results, file contents the agent read, and any secrets that appeared in them. Tell the user this in one or two sentences and wait for a yes before changing anything.

## Inputs

- `ORIGIN`: the public Traces Website origin, i.e. the origin of the `/install` URL the user gave you, such as `https://traces.example.workers.dev`. Uploads and file downloads go there. If you don't have it, ask the user.
- `HARNESS`: one of `claude-code`, `codex`, or `pi`. Use the agent you are running in. Amp and other agents aren't supported yet, so stop and tell the user.
- The `traces` MCP server must already be connected and signed in, because step 3 calls its `create_uploader` tool.

## 1. Pick a runtime

The uploader is a single dependency-free TypeScript file. It runs on `bun` or on `node` 22.18 or later, which strips types natively. Pick one and record its **absolute path** (`command -v bun` or `command -v node`) as `RUNTIME`. Hooks don't always inherit the shell's `PATH`, so always use the absolute path. If neither runtime is available, stop and ask the user to install Bun.

## 2. Download the uploader

```sh
mkdir -p ~/.traces/bin && chmod 700 ~/.traces
curl -fsSL "$ORIGIN/install/skills/install-traces/scripts/traces.ts" -o ~/.traces/bin/traces.ts
shasum -a 256 ~/.traces/bin/traces.ts   # or: sha256sum
```

Compare the digest with the `sha256` for `scripts/traces.ts` in the skill manifest. The manifest is `skills/list` on the MCP server, the files table on `/install`, or `$ORIGIN/install/skills/install-traces/manifest.json`. On a mismatch, delete the file and stop. If you can't reach `ORIGIN` over HTTP, read the MCP resource `skill://install-traces/scripts/traces.ts`, write it out byte for byte, and verify the digest the same way.

`~/.traces` is the default location. Respect `TRACES_HOME` if the user has set it.

## 3. Get an upload credential

If `"$RUNTIME" ~/.traces/bin/traces.ts status` already shows an uploader for this server, skip this step.

Otherwise, call the MCP tool `create_uploader` with `{"harness": HARNESS, "label": "<short hostname> <HARNESS>"}`. It returns a single-use `claimCode` that expires in 10 minutes. Exchange it right away:

```sh
"$RUNTIME" ~/.traces/bin/traces.ts login --url "$ORIGIN" --code <claimCode>
```

The login command writes the bearer token to `~/.traces/config.json` with mode 0600 and prints only the uploader ID. Never print, echo, `cat`, or copy the token, and never ask the user for one. If the claim fails, create a new uploader and revoke the stale one with `revoke_uploader`.

## 4. Install the turn-end hook

Read the reference for your harness and follow it:

- Claude Code: `references/claude-code.md`
- Codex: `references/codex.md`
- pi: `references/pi.md`

Merge into existing configuration and never replace it. Show the user the exact diff and get approval before writing it. Back up the original file first, e.g. `settings.json.bak-traces`.

## 5. Backfill existing sessions in the background

The sync uploads every past session for the harness, newest first. It's resumable and safe to re-run, and later turn-end uploads continue from the same cursors. It can take a while, so **run it in the background**:

- If your harness has a background-process feature (for example Claude Code's `run_in_background` for Bash), use it.
- Otherwise detach it: `nohup "$RUNTIME" ~/.traces/bin/traces.ts sync HARNESS > ~/.traces/sync.out 2>&1 &`

Don't wait for it to finish. Tell the user they can watch progress with `tail -f ~/.traces/sync.log` and `"$RUNTIME" ~/.traces/bin/traces.ts status`.

## 6. Verify

After a minute, call the MCP tool `list_sessions`. Sessions from the backfill should appear with this harness, its version, and this host. If none appear, check `~/.traces/upload.log`, which records only statuses and counts.

The turn-end hook takes effect in a **new** session of the agent, or after the harness reloads its hooks or extensions. Tell the user to restart the agent. After their next turn, `list_sessions` should show that session's `lastUploadedAt` advancing.

## 7. Report

Tell the user:

- which files were created or changed
- the uploader ID
- that the backfill is running and how to watch it

To uninstall, remove the hook entries (or the pi extension), delete `~/.traces`, and call `revoke_uploader` with the uploader ID.
