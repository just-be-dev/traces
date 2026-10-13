# Traces architecture and rollout

## Vertical slice

Agents stream their session transcripts. At the end of every turn, a harness hook (Claude Code `Stop`/`SubagentStop`/`SessionEnd`, Codex `Stop`/`SubagentStop`) or the pi extension (`agent_settled`, `session_shutdown`) starts the local uploader, `traces.ts`, in the background. The uploader reads the harness's session JSONL from its saved byte cursor and sends only the new complete lines to `POST /api/ingest`. Each request carries the client context (harness, harness version, uploader version, host, platform) and the session (ID, stream, cwd). Every line becomes one trace whose `raw` is the parsed line, unchanged. Its ID is `<harness>:<stream>:<key>`. The stream is the session ID, or `<session>/<stream>` for a secondary transcript such as a Claude Code subagent's, where the key is the harness's own entry ID (Claude `uuid`, Codex `ordinal`, pi `id`) or else `@<byte offset>`. Re-sending a slice is therefore a no-op, and the first payload wins. `event` is the entry `type` (refined by the Codex payload type or the pi message role), and the summary lists the tool names called. The `sessions` table (migration `0003`) records each session's provenance and entry count, and MCP `list_sessions` returns it.

The older single-event route, `POST /api/events`, still accepts envelopes from any Access-authenticated caller. `GET /api/events?q=<session-id-or-tool>` and stateless MCP `search_traces` return recent matching records (100 maximum). `GET /api/search?q=<words>` and MCP `search_trace_contents` search payload contents (see below). The remote MCP endpoint is `POST /mcp` **on the API Worker URL**, not the Website URL.

## Access and uploader credentials

All read paths and all MCP methods require a Cloudflare Access identity, including direct workers.dev access. The single-tenant Access application admits the configured owner's email and, optionally, a provisioned Access service token. The API Worker advertises managed OAuth with dynamic client registration for MCP clients.

Hooks are noninteractive, so they don't use Access. The owner signs in to the MCP server and calls `create_uploader`. It returns a single-use claim code that expires in 10 minutes. The local uploader exchanges the code at public `POST /api/uploaders/claim` for a bearer token and stores it in `~/.traces/config.json` with mode 0600. That way the long-lived token never appears in the model's context or transcript. D1 stores only SHA-256 digests of codes and tokens. The claim is a single `UPDATE … RETURNING`, so a code can't be claimed twice.

A token authenticates `POST /api/ingest` only. It appends traces for its owner and can't read anything. `list_uploaders` shows each uploader's claim and last use, and `revoke_uploader` disables a token immediately. Uploads go to the Website origin: its service-binding forwarding carries no Access identity, so the token is the only credential there. The API Worker URL stays entirely behind Access.

Before any deployment, set `TRACES_ACCESS_EMAIL` to the account allowed to inspect traces. Without it, the Access policy matches an invalid placeholder email and admits nobody, on purpose. `TRACES_ACCESS_SERVICE_TOKEN_ID` is now needed only for other noninteractive Access clients.

## Public hostname

Production serves everything from `https://traces.just-be.dev`. The `mise run deploy` task sets `TRACES_DOMAIN` and `TRACES_ACCESS_EMAIL`, and `src/platform/cloudflare/domain.ts` turns them into routing:

- **Website.** It has a custom domain for DNS and TLS, plus a `traces.just-be.dev/*` route. The route is required because the zone has a `*.just-be.dev/*` wildcard route, and routes take precedence over custom domains.
- **API Worker.** It gets more specific routes: `/mcp*`, `/api/events*`, `/api/search*`, and `/.well-known/*`. These routes outrank the Website's, and Worker-level Access covers every route the API Worker has, so these paths sign in through Access OAuth. The MCP URL is `https://traces.just-be.dev/mcp`.
- **Everything else** goes through the Website's service binding without an Access identity. That covers `/`, `/install*`, `/api/ingest`, `/api/uploaders/claim`, and `/api/health`.

Both workers.dev URLs stay enabled. Without `TRACES_DOMAIN` (as in `alchemy dev`), neither Worker gets routes or domains.

## Install flow

Point an agent at public `GET /install` on the Website. The page is Markdown and embeds the Website origin, the MCP URL, and a SHA-256 table of the skill files. It tells the agent to:

1. Connect and sign in to the `traces` MCP server.
2. Load the `install-traces` skill from it.

The MCP server implements the [Skills extension](https://modelcontextprotocol.io/extensions/skills/overview) (`io.modelcontextprotocol/skills`: `server/discover`, `skills/list`, `skills/get`, `resources/directory/read`). It also serves the same files as plain resources (`resources/list`/`resources/read`), because Claude Code, Codex, and pi don't support the extension yet but can read resources. The `inspect_hooks` tool returns any skill file for clients with neither. Agents download the larger files (the uploader script and pi extension) byte for byte from `/install/skills/install-traces/<path>` on the Website and verify them against the manifest, rather than re-typing them from a resource.

The skill (`src/install/skill/install-traces/`) walks the agent through these steps:

- get consent
- pick a runtime (Bun, or Node 22.18 or later)
- download and verify `~/.traces/bin/traces.ts`
- call `create_uploader` and `traces.ts login`
- merge the hook config for the harness, showing the user the diff
- start `traces.ts sync <harness>` in the background to backfill every existing session, newest first
- verify the result with `list_sessions`

The sync and the turn-end uploads share cursors and per-file locks, so they can overlap safely.

The uploader never writes to stdout in hook mode, always exits 0, and detaches its upload, so it never delays a turn. Entries over 1 MB are skipped and logged locally by offset. On a network error, 429, or 5xx it retries and leaves the cursor in place. On 401 it stops. If the server rejects a batch with 400, 413, or 422, it splits the batch and skips any single entry that is still rejected. Local logs (`~/.traces/upload.log`, `sync.log`) hold file names, offsets, counts, and statuses only.

| Agent       | Turn trigger                                                        | Backfill source                                      |
| ----------- | ------------------------------------------------------------------- | ---------------------------------------------------- |
| Claude Code | `Stop`, `SubagentStop`, `SessionEnd` hooks (`transcript_path`)      | `~/.claude/projects/**/*.jsonl`, including subagents |
| Codex       | `Stop`, `SubagentStop` hooks; new hooks must be trusted in `/hooks` | `~/.codex/sessions`, `~/.codex/archived_sessions`    |
| pi          | Extension: `agent_settled`, `session_shutdown`                      | `~/.pi/agent/sessions/**/*.jsonl`                    |
| Amp         | None verified                                                       | MCP search only                                      |

## Storage and risk

D1 is the interactive session index and raw event store for this first slice. A transcript entry may be up to 1 MB of JSON. A batch may hold up to 500 entries and 8 MB, and it must declare `content-length` (the uploader sends at most 200 entries or 4 MB). `/api/events` search is by exact session ID or escaped substring of projected tool/event names. Full-text search over payloads uses Cloudflare AI Search, described next. Source-specific mapping currently extracts `tool_name` or `toolName`, falling back to the event name; the complete source JSON remains in `raw` for later reinterpretation. Other agent event shapes need sample fixtures before richer mapping. A stored row that no longer decodes, such as one with malformed raw JSON or a retired source, is skipped in search results and logged by event ID only. Its raw column stays in D1 for a later migration. D1 failures return `503` on HTTP routes and JSON-RPC error `-32603` from MCP. Malformed JSON bodies return `400`.

## Content search

[Cloudflare AI Search](https://developers.cloudflare.com/ai-search/) holds a derived, plain-text copy of each trace; D1 stays the source of truth. `searchText` in `src/traces.ts` renders the envelope plus one `path: value` line per scalar in the raw payload, with strings unescaped, so prompts, commands and tool output read as written. The instance (`src/platform/cloudflare/search.ts`) uses built-in storage, so the Worker uploads each document through the Items binding and it is indexed immediately rather than on a sync schedule. It is keyword-only (BM25, no embeddings) with the trigram tokenizer: every whitespace-separated query term must appear, terms match substrings case-insensitively, and terms shorter than three characters may not match. Results are best match first, at most 20 events. Keyword queries bill as full-text queries.

Each document is named by a SHA-256 digest of `(owner, event ID)` and carries `owner` and `event_id` metadata. Uploads upsert by name, so re-indexing is idempotent. Search filters by `owner` in AI Search and then reads hits back from D1 through the owner's scope, so another owner's event can never be returned even if the index misbehaved. Hits whose `event_id` is missing or doesn't match a stored event are dropped. AI Search filters only the first 64 bytes of a string, which is another reason the D1 read re-checks ownership.

`POST /api/events` succeeds once D1 stores the event. It then uploads the document and sets `events.indexed_at` (migration `0002`). If the upload fails, the submission still succeeds, a warning is logged with the operation only, and the row stays unindexed. Ingested transcript entries are stored in D1 only and left to the sweep. A cron trigger runs every minute and indexes up to 100 unindexed rows, newest first, eight at a time. At most 144,000 entries a day, so a large backfill becomes searchable over hours. Each run loads at most 8 MB of raw JSON, but always at least one row, so large entries can't exhaust the isolate. Each indexed row costs one AI Search upload and one D1 write. That sweep also backfills events stored before content search existed. Overlapping or repeated sweeps are safe because uploads upsert. A row that no longer decodes stays unindexed and is logged by event ID on each sweep that reaches it. A duplicate submission is never uploaded, so the first payload wins in the index too. Content search failures return `503` (`Trace content search unavailable`) and JSON-RPC `-32603`; ingestion and `/api/events` keep working during an AI Search outage.

Alchemy 2.0.0-beta.81 cannot declare a built-in-storage instance, so `patches/alchemy@2.0.0-beta.81.patch` adds `type: "builtin"`; see `patches/README.md`. AI Search has no local emulation, so `mise run dev` creates a real instance for the dev stage. Under dev, `search` goes through Alchemy's remote binding, but `items.upload` fails with `The RPC receiver does not implement the method "upload"`. Traces stay unindexed, and the sweep logs a warning every minute. Content search is only exercised end to end on a deployed stage. Deleting a trace from D1 does not yet delete its document; retention work must cover both stores.

## Telemetry

Both Workers send Workers Observability logs and traces, sampling every request at prototype volume. Lower both rates together in `src/platform/cloudflare/api.ts` once traffic grows. On the API Worker, `Cloudflare.Telemetry` mirrors Effect spans into the Cloudflare trace waterfall. Each request gets an `Api.request` server span with method, path, matched route and status. Operations nest under it as `Traces.*`, `TraceStore.*`, `TraceIndex.*`, `Ingest.*`, `UploaderStore.*`, `SessionStore.*`, `Mcp.*`, `Identity.owner` and `Install.*`. Ingest spans carry the harness and counts, never tokens, claim codes, session IDs, or entries. The cron sweep is its own root span, `Traces.indexPending`, with indexed and failed counts. Spans and logs never carry search queries, session IDs, event IDs (except when a stored row fails to decode), headers or payloads. `src/api.test.ts` enforces this for spans. D1 row size, write throughput, retention/deletion, secret redaction, pagination, tenant separation, and Access OAuth client interoperability need evaluation before real traces containing sensitive prompts are accepted.

[Cloudflare Basin/Pipelines](https://developers.cloudflare.com/basin/) is GA and supports Worker/HTTP stream ingestion into Iceberg and SQL query. Ingestion-to-query can take minutes, so it is an **analytics/archive candidate**, not the interactive index. Evaluate pricing, size limits and propagation latency against production volume before adding a fan-out. No Basin resources or paid deployment have been created.
