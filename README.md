# Traces

Agent trace collection and search on Cloudflare, built with Effect 4, Alchemy v2, Foldkit and Bun. This is a single-tenant **prototype**, deployed at https://traces.just-be.dev.

```sh
mise trust && mise install
mise run check
mise run build
mise run dev
```

Production lives at **https://traces.just-be.dev**; `mise run deploy` sets `TRACES_DOMAIN` and `TRACES_ACCESS_EMAIL` (see [Public hostname](docs/traces.md#public-hostname)). In dev, Alchemy prints separate Website and API Worker URLs. To start collecting traces, tell your coding agent to read **`/install` on the Website URL** (in production, `https://traces.just-be.dev/install`). The page has the agent connect the `traces` MCP server (Cloudflare Access sign-in) and load the `install-traces` skill from it. The skill installs a local uploader plus a turn-end hook for Claude Code or Codex, or an extension for pi, and then backfills existing sessions in the background. After every turn, the hook uploads only the new transcript lines, along with the harness, its version, and the host.

The API Worker accepts:

- `GET /api/health`
- `POST /api/events`
- `GET /api/events?q=<session-or-tool>`
- full-text `GET /api/search?q=<words>` over payload contents
- stateless Streamable HTTP `POST /mcp`

The MCP tools are `search_traces`, `search_trace_contents`, `list_sessions`, `create_uploader`, `list_uploaders`, `revoke_uploader`, and `inspect_hooks`. The MCP server also serves the skill through the Skills extension and as resources.

Uploaders send to `POST /api/ingest` on the Website with a bearer token. They get the token by exchanging a single-use claim code from `create_uploader`. Local dev simulates Cloudflare Access. Production read routes fail closed without an authenticated Access context. Do **not** use this prototype with sensitive real traces until retention, redaction, limits, and OAuth-client interoperability have been reviewed.

An example local event:

```sh
curl -X POST "$API_URL/api/events" -H 'content-type: application/json' \
  -d '{"id":"example-1","source":"claude-code","sessionId":"session-1","event":"PostToolUse","occurredAt":"2026-10-09T12:00:00Z","raw":{"tool_name":"Read","tool_input":{"file_path":"README.md"}}}'
curl "$API_URL/api/events?q=session-1"
curl "$API_URL/api/search?q=README"
```

See [architecture, Access, uploader credentials, and the install flow](docs/traces.md). The [original Cloudflare guide](docs/cloudflare.md) and [tooling guide](docs/tooling.md) remain useful for the underlying template. This project was adapted from [effect-cloudflare-foldkit-template](https://github.com/just-be-dev/effect-cloudflare-foldkit-template).

Deploying, changing Cloudflare Access policies, provisioning service tokens, or pushing this repository needs explicit approval. Without `TRACES_ACCESS_EMAIL` the Access policy admits no one, on purpose; the deploy task sets it. Migration `0003` adds the `uploaders` and `sessions` tables. Local `mise run dev` emulates D1 locally, but **AI Search has no local emulation**: dev creates a real AI Search instance in your Cloudflare account for the dev stage. Search queries reach it, but uploading documents through the dev remote binding fails (`The RPC receiver does not implement the method "upload"`), so content search returns nothing under dev. Ingestion and `/api/events` work normally. Full-text search billing starts November 1, 2026.
