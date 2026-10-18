import * as Array from "effect/Array";
import type { Html, HtmlBuilder } from "foldkit/html";
import { cn } from "@/lib/utils";
import type { UsageStats } from "../../usage.ts";
import {
  calendar,
  type Cell,
  compact,
  full,
  hourLabel,
  LEVELS,
  longDay,
  monthLabels,
  plural,
  SOURCE_NAMES,
  summarize,
  totalTokens,
} from "../domain/activity.ts";
import { Message } from "../message.ts";
import type { StatsState } from "../main.ts";

// Styled after just-be.dev: monospace, black on white, gray secondary text, no
// cards or rounding, spacing in line heights, and inverted hover states.

const LEVEL_CLASSES = ["bg-heat-0", "bg-heat-1", "bg-heat-2", "bg-heat-3", "bg-heat-4"];
const WEEKDAY_LABELS = ["", "mon", "", "wed", "", "fri", ""];
/** Calendar cell size plus gap, in pixels. */
const PITCH = 15;

const cellTitle = (cell: Cell) =>
  cell.activity
    ? `${longDay(cell.day)}: ${plural(cell.activity.responses, "response")}, ${compact(totalTokens(cell.activity))} tokens, ${plural(cell.activity.sessions, "session")}`
    : `${longDay(cell.day)}: no activity`;

const cellView = (cell: Cell | undefined, h: HtmlBuilder<Message>): Html =>
  cell
    ? h.div([
        h.Class(cn("size-[13px]", LEVEL_CLASSES[cell.level])),
        h.Title(cellTitle(cell)),
        h.DataAttribute("level", String(cell.level)),
      ])
    : h.div([h.Class("size-[13px]"), h.AriaHidden(true)]);

const legend = (h: HtmlBuilder<Message>) =>
  h.div(
    [h.Class("flex items-center gap-[2px] text-muted-foreground"), h.AriaHidden(true)],
    [
      h.span([h.Class("mr-[1ch]")], ["less"]),
      ...Array.makeBy(LEVELS, (level) => h.div([h.Class(cn("size-[13px]", LEVEL_CLASSES[level]))])),
      h.span([h.Class("ml-[1ch]")], ["more"]),
    ],
  );

const heatmap = (
  stats: Pick<UsageStats, "from" | "to" | "days">,
  label: string,
  h: HtmlBuilder<Message>,
): Html => {
  const weeks = calendar(stats);
  // A label needs about two columns; one on the last column would be clipped.
  const months = monthLabels(weeks).filter(({ column }) => column < weeks.length - 1);
  // NOTE: On narrow screens the scroll container is right-to-left so it opens on the
  // most recent weeks, like GitHub's; the calendar inside is laid out left to right.
  return h.div(
    [h.Class("overflow-x-auto [direction:rtl] md:[direction:ltr]")],
    [
      h.div(
        [h.Class("inline-grid grid-cols-[auto_1fr] gap-x-[1ch] [direction:ltr]")],
        [
          h.div([]),
          h.div(
            [
              h.Class("relative h-[1lh] text-muted-foreground"),
              h.Style({ width: `${weeks.length * PITCH}px` }),
              h.AriaHidden(true),
            ],
            months.map(({ column, label: month }) =>
              h.span(
                [h.Class("absolute lowercase"), h.Style({ left: `${column * PITCH}px` })],
                [month],
              ),
            ),
          ),
          h.div(
            [
              h.Class("grid grid-rows-7 gap-[2px] text-xs leading-[13px] text-muted-foreground"),
              h.AriaHidden(true),
            ],
            WEEKDAY_LABELS.map((weekday) => h.span([], [weekday])),
          ),
          h.div(
            [
              h.Class("grid grid-flow-col grid-rows-7 gap-[2px]"),
              h.Role("img"),
              h.AriaLabel(label),
            ],
            weeks.flatMap((week) => week.map((cell) => cellView(cell, h))),
          ),
        ],
      ),
    ],
  );
};

const sectionHeading = (title: string, h: HtmlBuilder<Message>) =>
  h.h2([h.Class("mb-[1lh] font-bold")], [title]);

const statRow = (label: string, value: string, detail: string, h: HtmlBuilder<Message>) =>
  h.div(
    [h.Class("contents")],
    [
      h.dt([h.Class("text-muted-foreground")], [label]),
      h.dd([h.Class("font-bold tabular-nums")], [value]),
      h.dd([h.Class("text-muted-foreground")], [detail]),
    ],
  );

interface Bar {
  readonly key: string;
  readonly label: string;
  readonly detail: string;
  readonly value: number;
  readonly display: string;
}

/** A table like just-be.dev's project list: name, detail, bar, and count per row. */
const barList = (
  title: string,
  bars: ReadonlyArray<Bar>,
  empty: string,
  h: HtmlBuilder<Message>,
): Html => {
  const max = Math.max(1, ...bars.map((bar) => bar.value));
  return h.section(
    [h.AriaLabel(title)],
    [
      sectionHeading(title, h),
      Array.match(bars, {
        onEmpty: () => h.p([h.Class("text-muted-foreground")], [empty]),
        onNonEmpty: (items) =>
          h.ul(
            [
              h.Class(
                "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-[2ch] sm:grid-cols-[auto_auto_minmax(4ch,1fr)_auto]",
              ),
            ],
            items.map((bar) =>
              h.keyed("li")(
                bar.key,
                [h.Class("contents")],
                [
                  h.span([h.Class("truncate font-bold")], [bar.label]),
                  h.span([h.Class("truncate text-muted-foreground max-sm:hidden")], [bar.detail]),
                  h.span(
                    [h.Class("h-[0.6lh] bg-muted max-sm:hidden"), h.AriaHidden(true)],
                    [
                      h.span([
                        h.Class("block h-full bg-foreground"),
                        h.Style({ width: `${Math.max(1, (bar.value / max) * 100)}%` }),
                      ]),
                    ],
                  ),
                  h.span(
                    [h.Class("text-right whitespace-nowrap tabular-nums text-muted-foreground")],
                    [bar.display],
                  ),
                ],
              ),
            ),
          ),
      }),
    ],
  );
};

const hoursChart = (hours: ReadonlyArray<number>, h: HtmlBuilder<Message>): Html => {
  const max = Math.max(1, ...hours);
  return h.section(
    [h.AriaLabel("Time of day")],
    [
      sectionHeading("Time of day", h),
      h.div(
        [h.Class("flex h-[5lh] items-end gap-[2px] border-b border-foreground")],
        hours.map((count, hour) =>
          h.div([
            h.Class("flex-1 bg-foreground"),
            h.Style({ height: `${(count / max) * 100}%` }),
            h.Title(`${hourLabel(hour)}: ${plural(count, "response")}`),
          ]),
        ),
      ),
      h.div(
        [h.Class("flex justify-between text-muted-foreground"), h.AriaHidden(true)],
        ["12am", "6am", "12pm", "6pm", "11pm"].map((label) => h.span([], [label])),
      ),
    ],
  );
};

const loadedView = (stats: UsageStats, h: HtmlBuilder<Message>): Html => {
  const summary = summarize(stats);
  const label = `${compact(summary.tokens)} tokens on ${plural(summary.activeDays, "day")} between ${longDay(stats.from)} and ${longDay(stats.to)}`;
  return h.div(
    [h.Class("flex flex-col gap-[2lh]")],
    [
      h.section(
        [h.AriaLabel("Activity")],
        [
          sectionHeading(`${compact(summary.tokens)} tokens in the last year`, h),
          heatmap(stats, label, h),
          h.div(
            [
              h.Class(
                "mt-[1lh] flex flex-wrap items-center justify-between gap-x-[2ch] text-muted-foreground",
              ),
            ],
            [
              h.span(
                [],
                [
                  summary.busiest
                    ? `Busiest day: ${longDay(summary.busiest.day)}, ${compact(totalTokens(summary.busiest))} tokens`
                    : "No activity yet.",
                ],
              ),
              legend(h),
            ],
          ),
        ],
      ),
      h.dl(
        [h.Class("grid grid-cols-[auto_auto_1fr] gap-x-[2ch]"), h.AriaLabel("Totals")],
        [
          statRow(
            "tokens",
            compact(summary.tokens),
            `${compact(summary.inputTokens)} in · ${compact(summary.outputTokens)} out · ${compact(summary.cacheReadTokens + summary.cacheWriteTokens)} cache`,
            h,
          ),
          statRow(
            "sessions",
            full(summary.sessions),
            summary.sessions > 0
              ? `${full(Math.round(summary.responses / summary.sessions))} responses per session`
              : "none yet",
            h,
          ),
          statRow(
            "active days",
            full(summary.activeDays),
            `of ${full(summary.windowDays)} · peak hour ${summary.peakHour === undefined ? "—" : hourLabel(summary.peakHour)}`,
            h,
          ),
          statRow(
            "streak",
            plural(summary.currentStreak, "day"),
            `longest ${plural(summary.longestStreak, "day")}`,
            h,
          ),
        ],
      ),
      barList(
        "Models",
        stats.models.map((model) => ({
          key: model.model ?? "",
          label: model.model ?? "unknown model",
          detail: model.sources.map((source) => SOURCE_NAMES[source] ?? source).join(", "),
          value: model.responses,
          display: `${compact(model.responses)} · ${compact(totalTokens(model))} tok`,
        })),
        "No model responses yet.",
        h,
      ),
      barList(
        "Harnesses",
        stats.sources.map((source) => ({
          key: source.source,
          label: SOURCE_NAMES[source.source] ?? source.source,
          detail: plural(source.sessions, "session"),
          value: source.responses,
          display: `${compact(source.responses)} · ${compact(totalTokens(source))} tok`,
        })),
        "No harnesses yet.",
        h,
      ),
      hoursChart(stats.hours, h),
    ],
  );
};

const PLACEHOLDER_WINDOW = { from: "2025-10-12", to: "2026-10-17", days: [] };

/** An empty calendar for states without data, so the page keeps its shape. */
const placeholder = (h: HtmlBuilder<Message>) =>
  h.div(
    [h.Class("pointer-events-none mt-[1lh]"), h.AriaHidden(true)],
    [heatmap(PLACEHOLDER_WINDOW, "No activity", h)],
  );

export const activityView = (state: StatsState, h: HtmlBuilder<Message>): Html =>
  // NOTE: Matched by tag rather than through StatsState.match, which would import
  // main.ts at runtime and create a cycle.
  state._tag === "Loaded"
    ? loadedView(state.stats, h)
    : state._tag === "Unavailable"
      ? h.section(
          [h.AriaLabel("Activity")],
          [
            h.p(
              [],
              [
                h.span([h.Class("font-bold")], ["Stats are unavailable."]),
                " The usage service didn't answer. ",
                h.button(
                  [
                    h.Type("button"),
                    h.OnClick(Message.ClickedRetry()),
                    h.Class(
                      "cursor-pointer font-bold underline decoration-2 hover:bg-background hover:invert focus-visible:invert focus-visible:outline-none",
                    ),
                  ],
                  ["Try again"],
                ),
              ],
            ),
            placeholder(h),
          ],
        )
      : h.section(
          [h.AriaLabel("Activity"), h.AriaBusy(true)],
          [h.p([h.Class("text-muted-foreground")], ["Loading activity…"]), placeholder(h)],
        );
