import { expect, test } from "bun:test";
import { apiUrl } from "./api.ts";

test("API routes resolve against the app's base, including under a mount", () => {
  expect(apiUrl("api/stats", "https://traces.just-be.dev/assets/index-abc.js", false)).toBe(
    "https://traces.just-be.dev/api/stats",
  );
  expect(apiUrl("api/stats", "https://just-be.dev/traces/assets/index-abc.js", false)).toBe(
    "https://just-be.dev/traces/api/stats",
  );
  expect(apiUrl("/api/stats", "https://just-be.dev/traces/assets/index-abc.js", false)).toBe(
    "https://just-be.dev/traces/api/stats",
  );
});

test("the dev server resolves API routes against the origin root", () => {
  expect(apiUrl("api/stats", "http://localhost:5173/src/ui/command.ts", true)).toBe(
    "http://localhost:5173/api/stats",
  );
});
