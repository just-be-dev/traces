# Dependency patches

Bun applies these patches on install through `patchedDependencies` in `package.json`. Each patch is tied to an exact version. When you upgrade a patched package, check whether upstream fixed the problem. Then either drop the patch or recreate it with `mise run patch <pkg>` and `mise run patch:commit <pkg>`, and update this file.

Every patch needs an entry here. Inside the patched code, mark the change with a `PATCH:` comment.

## Foldkit DevTools MCP reconnect loop under `alchemy dev`

Patches `@foldkit/vite-plugin@0.26.0` and `@foldkit/devtools-mcp@0.24.0`.

**Symptom.** Under `alchemy dev`, every agent session's Foldkit DevTools MCP server connected to the relay and disconnected many times per second. The MCP tools were unusable, and the dev server log filled with `MCP client connected` and `MCP client disconnected` lines.

**Cause.** Two upstream behaviors combine:

1. `@foldkit/vite-plugin` hosts its MCP relay at `/__foldkit/devtools-mcp` on Vite's own `httpServer`. Alchemy's Cloudflare Vite integration (`handleWebSocket` in `@alchemy.run/cloudflare-runtime`, `src/vite/websockets.ts`) adds its own `upgrade` listener to the same server. That listener forwards every upgrade whose `sec-websocket-protocol` doesn't start with `vite` to workerd. The worker answers with a non-101 response, so Alchemy destroys the socket Foldkit has already accepted. The client sees the connection open and then close with code 1006 about 20 ms later.
2. `@foldkit/devtools-mcp` only backs off when an open fails. When a socket opens and then closes, it reconnects immediately, so (1) turns into a tight loop.

**Patches.**

- `@foldkit/vite-plugin`: `startMcpRelay` always uses `bindLoopbackRelay`, which is a token-protected listener on its own `127.0.0.1` port, published to the relay registry. The relay no longer attaches to Vite's `httpServer`, so Alchemy's upgrade listener never sees it. The fixed `devToolsMcpPort` path is unchanged.
- `@foldkit/devtools-mcp`: in `webSocketClient.js`, a connection that closes within 5 seconds of opening counts as a failure. Reconnects then back off exponentially, from 0.5 s up to 30 s. A connection that stays up longer resets the backoff.

**Remove when** either fix lands upstream and the dev server log shows one stable `MCP client connected` per MCP server under `alchemy dev`:

- Foldkit hosts the relay on a dedicated loopback listener, or otherwise keeps it away from other upgrade handlers, and backs off reconnects after short-lived connections.
- Alchemy's `handleWebSocket` stops forwarding upgrades that another listener has already handled, or only forwards paths the worker serves.

The backoff patch is worth keeping until Foldkit has its own backoff. It stops the loop whatever the cause of the drop.

## Alchemy AI Search built-in storage

Patches `alchemy@2.0.0-beta.81` (`src/`, `lib/*.js` and `lib/*.d.ts` of `Cloudflare/AI/SearchInstance`, because Bun loads `src` while types and Node load `lib`).

**Symptom.** `Cloudflare.AI.SearchInstance` could only declare R2 or web-crawler instances. Traces needs a built-in-storage instance that the Worker fills through the Items binding (`items.upload`), so new events are searchable right away instead of after an R2 sync.

**Cause.** Cloudflare creates a built-in-storage instance when the create request omits `type` and `source`. The provider requires `source` and always sends `type: news.type ?? "r2"`. It also maps an instance with no reported type to `"r2"`, which would make every later plan diff as a replacement.

**Patch.** Adds `"builtin"` to `SearchInstanceSourceType` and makes `source` optional. On create, `type: "builtin"` omits `type`, and `undefined` body fields are stripped. On read, an instance with neither type nor source maps to `"builtin"`, so it diffs as unchanged.

**Remove when** Alchemy can declare a built-in-storage AI Search instance and reads one back without a replacement diff. Then switch `src/platform/cloudflare/search.ts` to the upstream form.

**Not yet verified against the live API.** Tests cover the adapter with a fake binding. The first `mise run dev` must confirm that the instance is created, a second plan shows no change, and an uploaded event is searchable.
