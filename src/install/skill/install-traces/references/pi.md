# pi

pi has no command hooks, so the upload trigger is a small extension. On `agent_settled`, which marks the end of a user turn after any automatic continuation, and on `session_shutdown`, it starts a detached run of the uploader:

```text
<runtime> ~/.traces/bin/traces.ts upload pi <session file> --harness-version <pi version>
```

It never blocks the agent, and it does nothing until `~/.traces/config.json` and `~/.traces/bin/traces.ts` exist.

## Install the extension

```sh
mkdir -p ~/.pi/agent/extensions
curl -fsSL "$ORIGIN/install/skills/install-traces/extensions/traces.ts" -o ~/.pi/agent/extensions/traces.ts
shasum -a 256 ~/.pi/agent/extensions/traces.ts
```

Verify the digest against the manifest entry for `extensions/traces.ts`. If `PI_CODING_AGENT_DIR` is set, use `$PI_CODING_AGENT_DIR/extensions/` instead. If the user already has a `traces.ts` extension there, show it to them before replacing it.

Extensions run with the user's full permissions. Tell the user what this one does, in one sentence, before installing it.

Run `/reload` in pi, or restart it, to load the extension. In this session you can't trigger `/reload` yourself, so ask the user to.

## Runtime

The extension reuses pi's own Node runtime when it's 22.18 or later, and falls back to `bun` on `PATH`. If neither works, it does nothing. Make sure step 1 found a runtime.

## Backfill

```sh
nohup "$RUNTIME" ~/.traces/bin/traces.ts sync pi > ~/.traces/sync.out 2>&1 &
```

The sync covers `~/.pi/agent/sessions/**/*.jsonl`.

Reference: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md
