# Dependency patches

Bun applies these patches on install through `patchedDependencies` in `package.json`. Each patch is tied to an exact version. When you upgrade a patched package, check whether upstream fixed the problem. Then either drop the patch or recreate it with `mise run patch <pkg>` and `mise run patch:commit <pkg>`, and update this file.

Every patch needs an entry here. Inside the patched code, mark the change with a `PATCH:` comment.

## Alchemy AI Search built-in storage

Patches `@alchemy.run/cloudflare@2.0.0-beta.85` (`src/`, `lib/*.js` and `lib/*.d.ts` of `AI/SearchInstance`, because Bun loads `src` while types and Node load `lib`). Ported from the `alchemy@2.0.0-beta.83` patch when the Cloudflare provider moved out of `alchemy` into its own package; beta.85 still lacks built-in storage.

**Symptom.** `Cloudflare.AI.SearchInstance` could only declare R2 or web-crawler instances. Traces needs a built-in-storage instance that the Worker fills through the Items binding (`items.upload`), so new events are searchable right away instead of after an R2 sync.

**Cause.** Cloudflare creates a built-in-storage instance when the create request omits `type` and `source`. The provider requires `source` and always sends `type: news.type ?? "r2"`. It also maps an instance with no reported type to `"r2"`, which would make every later plan diff as a replacement.

**Patch.** Adds `"builtin"` to `SearchInstanceSourceType` and makes `source` optional. On create, `type: "builtin"` omits `type`, and `undefined` body fields are stripped. On read, an instance with neither type nor source maps to `"builtin"`, so it diffs as unchanged.

**Remove when** Alchemy can declare a built-in-storage AI Search instance and reads one back without a replacement diff. Then switch `src/platform/cloudflare/search.ts` to the upstream form.

**Not yet verified against the live API.** Tests cover the adapter with a fake binding. The first `mise run dev` must confirm that the instance is created, a second plan shows no change, and an uploaded event is searchable.
