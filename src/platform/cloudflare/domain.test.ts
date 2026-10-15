import { expect, test } from "bun:test";
import { accessPaths } from "./domain.ts";

// Routes whose handlers call `authorize()`. On the public domain each must reach the
// API Worker directly, behind Access; through the Website it would carry no identity.
const privateRoutes = ["/mcp", "/api/events", "/api/search"];

const matches = (pattern: string, path: string) =>
  pattern.endsWith("*") ? path.startsWith(pattern.slice(0, -1)) : path === pattern;

test("every private route is served behind Access on the public domain", () => {
  for (const path of privateRoutes)
    expect(accessPaths.some((pattern) => matches(pattern, path))).toBe(true);
  for (const path of [
    "/",
    "/install",
    "/api/ingest",
    "/api/uploaders/claim",
    "/api/health",
    "/api/stats",
  ])
    expect(accessPaths.some((pattern) => matches(pattern, path))).toBe(false);
});
