# Claude Code

Claude Code passes every hook a JSON payload on stdin that includes `transcript_path`, the session's JSONL transcript. `SubagentStop` also passes `agent_transcript_path`. The uploader's `hook` command reads the payload, starts a detached upload of the new lines, and exits immediately, so it never delays a turn. It writes nothing to stdout and always exits 0.

## Settings file

Use the user settings, `~/.claude/settings.json` (or `$CLAUDE_CONFIG_DIR/settings.json` if that's set), so every project is covered. Create the file as `{}` if it doesn't exist.

Merge these three entries into the existing `hooks` object. Append to an event's array when it already exists. Don't touch other hooks or settings.

Replace `RUNTIME` with the runtime's absolute path and `HOME` with the absolute home directory. Claude Code runs commands through a shell, so keep the quotes.

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "'RUNTIME' 'HOME/.traces/bin/traces.ts' hook claude-code",
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
            "command": "'RUNTIME' 'HOME/.traces/bin/traces.ts' hook claude-code",
            "timeout": 10
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "'RUNTIME' 'HOME/.traces/bin/traces.ts' hook claude-code",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

- `Stop` fires at the end of every turn, `SubagentStop` when a subagent finishes (its transcript is a separate file), and `SessionEnd` when the session closes. The SessionEnd upload catches anything written after the last turn.
- Before you write, validate the merged file with `jq . ~/.claude/settings.json` or by parsing it.
- Claude Code snapshots hooks at startup. The hooks apply to new sessions. A running session may ask the user to review the change in `/hooks`.

## Backfill

```sh
nohup "$RUNTIME" ~/.traces/bin/traces.ts sync claude-code > ~/.traces/sync.out 2>&1 &
```

Prefer Bash's `run_in_background` option when it's available. The sync covers `~/.claude/projects/**/*.jsonl`, including subagent transcripts.

## Version

The uploader runs `claude --version` (cached for a day) and sends it with each upload. To override it, set `TRACES_HARNESS_VERSION`.

Reference: https://code.claude.com/docs/en/hooks
