import * as Array from "effect/Array";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type { DayActivity, Tokens, UsageStats } from "../../usage.ts";

/** What the activity calendar colors each day by. */
export const Metric = Schema.Literals(["responses", "tokens", "sessions"]);
export type Metric = typeof Metric.Type;

export const LEVELS = 5;

export interface Cell {
  readonly day: string;
  readonly activity: DayActivity | undefined;
  readonly value: number;
  /** 0 for no activity, then 1–4 by quartile of active days. */
  readonly level: number;
}

const MS_PER_DAY = 86_400_000;

const dayMs = (day: string) => Date.parse(`${day}T00:00:00Z`);
const dayAt = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export const totalTokens = (tokens: Tokens) =>
  tokens.inputTokens + tokens.outputTokens + tokens.cacheReadTokens + tokens.cacheWriteTokens;

export const metricValue = (activity: DayActivity, metric: Metric) =>
  metric === "responses"
    ? activity.responses
    : metric === "sessions"
      ? activity.sessions
      : totalTokens(activity);

/** Upper bounds of levels 1–3 over the active days' values; above the last is level 4. */
const thresholds = (values: ReadonlyArray<number>) => {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (fraction: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))] ?? 0;
  return [at(0.25), at(0.5), at(0.75)];
};

const levelOf = (value: number, bounds: ReadonlyArray<number>) =>
  value <= 0 ? 0 : 1 + bounds.filter((bound) => value > bound).length;

/**
 * Weeks of the window as calendar columns, Sunday first, like GitHub. Days of the
 * first and last weeks outside the window are `undefined`.
 */
export const calendar = (
  stats: Pick<UsageStats, "from" | "to" | "days">,
  metric: Metric,
): ReadonlyArray<ReadonlyArray<Cell | undefined>> => {
  const byDay = new Map(stats.days.map((activity) => [activity.day, activity]));
  const bounds = thresholds(stats.days.map((activity) => metricValue(activity, metric)));
  const start = dayMs(stats.from) - new Date(dayMs(stats.from)).getUTCDay() * MS_PER_DAY;
  const end = dayMs(stats.to);
  const weeks = Math.floor((end - start) / MS_PER_DAY / 7) + 1;
  return Array.makeBy(weeks, (week) =>
    Array.makeBy(7, (weekday) => {
      const ms = start + (week * 7 + weekday) * MS_PER_DAY;
      if (ms < dayMs(stats.from) || ms > end) return undefined;
      const day = dayAt(ms);
      const activity = byDay.get(day);
      const value = activity ? metricValue(activity, metric) : 0;
      return { day, activity, value, level: levelOf(value, bounds) };
    }),
  );
};

/** Month labels for calendar columns: the first column whose Sunday falls in a new month. */
export const monthLabels = (
  weeks: ReadonlyArray<ReadonlyArray<Cell | undefined>>,
): ReadonlyArray<{ readonly column: number; readonly label: string }> => {
  // Columns are labeled by their Sunday; a partial first column has none, so its
  // label can't collide with the next one's.
  const sundays = weeks.map((week) => week[0]?.day);
  return Array.filterMap(weeks, (_, column) => {
    const sunday = sundays[column];
    const previous = column === 0 ? undefined : sundays[column - 1];
    return sunday !== undefined && previous?.slice(0, 7) !== sunday.slice(0, 7)
      ? Result.succeed({ column, label: monthName(sunday) })
      : Result.failVoid;
  });
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export const monthName = (day: string) => MONTHS[Number(day.slice(5, 7)) - 1] ?? "";

/** `Tue, Oct 14, 2026`. */
export const longDay = (day: string) => {
  const date = new Date(dayMs(day));
  return `${WEEKDAYS[date.getUTCDay()]?.slice(0, 3)}, ${monthName(day)} ${date.getUTCDate()}, ${date.getUTCFullYear()}`;
};

/**
 * Consecutive active days. The current streak counts back from today, or from
 * yesterday when today has no activity yet.
 */
export const streaks = (stats: Pick<UsageStats, "to" | "days">) => {
  const active = new Set(stats.days.filter((day) => day.responses > 0).map((day) => day.day));
  const runs = Array.reduce(
    [...active].map(dayMs).sort((a, b) => a - b),
    { longest: 0, run: 0, previous: Number.NaN },
    (state, ms) => {
      const run = ms - state.previous === MS_PER_DAY ? state.run + 1 : 1;
      return { longest: Math.max(state.longest, run), run, previous: ms };
    },
  );
  const today = dayMs(stats.to);
  const end = active.has(stats.to) ? today : today - MS_PER_DAY;
  const isActiveBefore = (count: number) => active.has(dayAt(end - count * MS_PER_DAY));
  const current = Array.makeBy(active.size + 1, (count) => count).findIndex(
    (count) => !isActiveBefore(count),
  );
  return { current, longest: runs.longest };
};

export interface Summary extends Tokens {
  readonly responses: number;
  readonly tokens: number;
  readonly activeDays: number;
  readonly windowDays: number;
  readonly sessions: number;
  readonly busiest: DayActivity | undefined;
  readonly peakHour: number | undefined;
  readonly currentStreak: number;
  readonly longestStreak: number;
}

export const summarize = (stats: UsageStats): Summary => {
  const tokens = stats.days.reduce<Tokens>(
    (sum, day) => ({
      inputTokens: sum.inputTokens + day.inputTokens,
      outputTokens: sum.outputTokens + day.outputTokens,
      cacheReadTokens: sum.cacheReadTokens + day.cacheReadTokens,
      cacheWriteTokens: sum.cacheWriteTokens + day.cacheWriteTokens,
    }),
    { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  );
  const busiest = stats.days.reduce<DayActivity | undefined>(
    (best, day) => (best === undefined || day.responses > best.responses ? day : best),
    undefined,
  );
  const peak = Math.max(0, ...stats.hours);
  const { current, longest } = streaks(stats);
  return {
    ...tokens,
    responses: stats.days.reduce((sum, day) => sum + day.responses, 0),
    tokens: totalTokens(tokens),
    activeDays: stats.days.filter((day) => day.responses > 0).length,
    windowDays: (dayMs(stats.to) - dayMs(stats.from)) / MS_PER_DAY + 1,
    sessions: stats.sessions,
    busiest,
    peakHour: peak > 0 ? stats.hours.indexOf(peak) : undefined,
    currentStreak: current,
    longestStreak: longest,
  };
};

const compactFormat = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});
const fullFormat = new Intl.NumberFormat("en-US");

/** `1.2M`, `950`. */
export const compact = (value: number) => compactFormat.format(value);
/** `1,234,567`. */
export const full = (value: number) => fullFormat.format(value);

export const plural = (count: number, one: string, many = `${one}s`) =>
  `${full(count)} ${count === 1 ? one : many}`;

/** `3 PM`. */
export const hourLabel = (hour: number) =>
  `${hour % 12 === 0 ? 12 : hour % 12} ${hour < 12 ? "AM" : "PM"}`;

export const SOURCE_NAMES: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  pi: "pi",
  amp: "Amp",
};
