# Traces

Agent trace collection and search on Cloudflare, built with Effect 4, Alchemy v2, Foldkit and Bun. This is an **initial local prototype**, not a deployed service or a completed automatic hook installer.

```sh
mise trust && mise install
mise run check
mise run build
mise run dev
```

Alchemy prints separate Website and API Worker URLs. The Website is a product landing page; the API Worker accepts `GET /api/health`, `POST /api/events`, `GET /api/events?q=<session-or-tool>`, and stateless Streamable HTTP `POST /mcp` (tools: `search_traces` and read-only `inspect_hooks`). Local dev simulates Cloudflare Access. Production private routes fail closed without an authenticated Access context. Do **not** use this prototype with sensitive real traces until retention, redaction, limits, and OAuth-client interoperability have been reviewed.

An example local event:

```sh
curl -X POST "$API_URL/api/events" -H 'content-type: application/json' \
  -d '{"id":"example-1","source":"claude-code","sessionId":"session-1","event":"PostToolUse","occurredAt":"2026-10-09T12:00:00Z","raw":{"tool_name":"Read","tool_input":{"file_path":"README.md"}}}'
curl "$API_URL/api/events?q=session-1"
```

See [architecture, Access and hook integration plan](docs/traces.md). The [original Cloudflare guide](docs/cloudflare.md) and [tooling guide](docs/tooling.md) remain useful for the underlying template. This project was adapted from [effect-cloudflare-foldkit-template](https://github.com/just-be-dev/effect-cloudflare-foldkit-template).

Deploying, changing Cloudflare Access policies, provisioning service tokens, or pushing this repository needs explicit approval. Before deploying, set `TRACES_ACCESS_EMAIL` (and optionally `TRACES_ACCESS_SERVICE_TOKEN_ID`); the default email policy intentionally admits no one. Local `mise run dev` does not create remote Cloudflare resources.
