# Codex CLI

Codex command hooks receive a JSON payload on stdin. `Stop` (end of turn) includes `transcript_path`, the session's rollout JSONL. `SubagentStop` includes `agent_transcript_path`. The uploader's `hook` command starts a detached upload of the new lines and exits immediately. It writes nothing to stdout and always exits 0.

## Check support

Run `codex --version` and `codex features list | grep hooks`. Command hooks must show as enabled. If they don't, stop and tell the user that this Codex version can't stream traces. The backfill in step 5 still works.

## Hooks file

Use `~/.codex/hooks.json` (or `$CODEX_HOME/hooks.json`). Create it as `{"hooks": {}}` if it doesn't exist.

Merge these entries into the existing `hooks` object. Append to an event's array when it already exists, and preserve every other entry.

Replace `RUNTIME` with the runtime's absolute path and `HOME` with the absolute home directory.

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "'RUNTIME' 'HOME/.traces/bin/traces.ts' hook codex",
            "timeout": 10
          }
        ]
      }
    ],
    "SubagentStop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "'RUNTIME' 'HOME/.traces/bin/traces.ts' hook codex",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

- Validate the merged JSON before writing.
- Codex asks the user to trust new or changed hooks. Tell the user to approve the `traces` hooks the next time Codex starts (or in `/hooks`). Untrusted hooks don't run.
- Hooks apply to new sessions.

The legacy `notify` setting passes a CLI argument instead of JSON on stdin. Don't use it for this uploader.

## Backfill

```sh
nohup "$RUNTIME" ~/.traces/bin/traces.ts sync codex > ~/.traces/sync.out 2>&1 &
```

The sync covers `~/.codex/sessions/**/*.jsonl` and `~/.codex/archived_sessions/**/*.jsonl`.

## Version

The uploader runs `codex --version` (cached for a day). To override it, set `TRACES_HARNESS_VERSION`.
