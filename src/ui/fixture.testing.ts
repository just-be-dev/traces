import type { UsageStats } from "../usage.ts";

const tokens = (input: number, output: number, cacheRead: number) => ({
  inputTokens: input,
  outputTokens: output,
  cacheReadTokens: cacheRead,
  cacheWriteTokens: 0,
});

/** A window ending Wednesday 2026-10-14 with a three-day streak up to yesterday. */
export const stats: UsageStats = {
  from: "2025-10-09",
  to: "2026-10-14",
  days: [
    { day: "2025-10-09", responses: 1, sessions: 1, ...tokens(10, 5, 0) },
    { day: "2026-10-01", responses: 4, sessions: 1, ...tokens(100, 50, 1_000) },
    { day: "2026-10-11", responses: 2, sessions: 1, ...tokens(20, 10, 200) },
    { day: "2026-10-12", responses: 40, sessions: 3, ...tokens(4_000, 2_000, 900_000) },
    { day: "2026-10-13", responses: 10, sessions: 2, ...tokens(1_000, 500, 10_000) },
  ],
  hours: Array.from({ length: 24 }, (_, hour) => (hour === 15 ? 30 : hour === 9 ? 27 : 0)),
  models: [
    {
      model: "claude-opus-5-5",
      sources: ["claude-code", "pi"],
      responses: 45,
      ...tokens(5_000, 2_500, 900_000),
    },
    { sources: ["codex"], responses: 12, ...tokens(130, 65, 11_200) },
  ],
  sources: [
    { source: "claude-code", responses: 45, sessions: 5, ...tokens(5_000, 2_500, 900_000) },
    { source: "codex", responses: 12, sessions: 2, ...tokens(130, 65, 11_200) },
  ],
  sessions: 7,
};
