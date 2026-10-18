import { expect, test } from "bun:test";
import { stats } from "../fixture.testing.ts";
import {
  calendar,
  compact,
  hourLabel,
  longDay,
  monthLabels,
  streaks,
  summarize,
} from "./activity.ts";

test("the calendar has Sunday-first week columns covering exactly the window", () => {
  const weeks = calendar(stats);
  expect(weeks.every((week) => week.length === 7)).toBe(true);
  const days = weeks.flat().filter((cell) => cell !== undefined);
  expect(days[0]?.day).toBe(stats.from);
  expect(days.at(-1)?.day).toBe(stats.to);
  expect(days).toHaveLength(371);
  // 2025-10-09 is a Thursday, so the first column starts with four blanks.
  expect(weeks[0]?.slice(0, 4)).toEqual([undefined, undefined, undefined, undefined]);
  // 2026-10-14 is a Wednesday, so the last column ends with three blanks.
  expect(weeks.at(-1)?.slice(4)).toEqual([undefined, undefined, undefined]);
});

test("levels rank active days by quartile of total tokens", () => {
  const level = (day: string) =>
    calendar(stats)
      .flat()
      .find((cell) => cell?.day === day)?.level;
  expect(level("2026-10-12")).toBe(4);
  expect(level("2026-10-13")).toBe(3);
  expect(level("2026-10-01")).toBe(2);
  expect(level("2026-10-11")).toBe(1);
  expect(level("2025-10-09")).toBe(1);
  expect(level("2026-10-10")).toBe(0);
});

test("month labels mark the first full column of each month", () => {
  const labels = monthLabels(calendar(stats));
  expect(labels[0]).toEqual({ column: 1, label: "Oct" });
  expect(labels.map((label) => label.label).slice(0, 3)).toEqual(["Oct", "Nov", "Dec"]);
  expect(labels.at(-1)?.label).toBe("Oct");
});

test("streaks count back from today or yesterday, and find the longest run", () => {
  expect(streaks(stats)).toEqual({ current: 3, longest: 3 });
  expect(streaks({ ...stats, to: "2026-10-13" })).toEqual({ current: 3, longest: 3 });
  expect(streaks({ ...stats, to: "2026-10-16" })).toEqual({ current: 0, longest: 3 });
  expect(streaks({ ...stats, days: [] })).toEqual({ current: 0, longest: 0 });
});

test("the summary totals the window", () => {
  const summary = summarize(stats);
  expect(summary).toMatchObject({
    responses: 57,
    activeDays: 5,
    windowDays: 371,
    sessions: 7,
    peakHour: 15,
    currentStreak: 3,
    longestStreak: 3,
    inputTokens: 5_130,
  });
  expect(summary.busiest?.day).toBe("2026-10-12");
  expect(summary.tokens).toBe(5_130 + 2_565 + 911_200);
});

test("formatting", () => {
  expect(compact(911_200)).toBe("911.2K");
  expect(compact(1_250_000_000)).toBe("1.3B");
  expect(hourLabel(0)).toBe("12 AM");
  expect(hourLabel(15)).toBe("3 PM");
  expect(longDay("2026-10-14")).toBe("Wed, Oct 14, 2026");
});
