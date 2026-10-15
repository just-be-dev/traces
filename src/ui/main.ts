import * as Schema from "effect/Schema";
import type { Document, HtmlBuilder } from "foldkit/html";
import { defineTaggedUnion } from "foldkit/schema";
import { modifyFields } from "foldkit/struct";
import type * as Update from "foldkit/update";
import { UsageStats } from "../usage.ts";
import { cn } from "@/lib/utils";
import { Metric } from "./domain/activity.ts";
import { FetchStats } from "./command.ts";
import { Message } from "./message.ts";
import { activityView } from "./view/activity.ts";

export { Message } from "./message.ts";

// MODEL

export const StatsState = defineTaggedUnion({
  Loading: {},
  Unavailable: {},
  Loaded: { stats: UsageStats },
});
export type StatsState = typeof StatsState.Type;

export const Model = Schema.Struct({
  metric: Metric,
  stats: StatsState,
});
export type Model = typeof Model.Type;

// INIT

export const init = () => ({
  model: Model.make({ metric: "responses", stats: StatsState.Loading() }),
  commands: [FetchStats()],
});

// UPDATE

export const update = (model: Model, message: Message) =>
  Message.match<Update.Return<Model, Message>>(message, {
    ClickedRetry: () => ({
      model: modifyFields(model, { stats: () => StatsState.Loading() }),
      commands: [FetchStats()],
    }),
    SelectedMetric: ({ metric }) => ({ model: modifyFields(model, { metric: () => metric }) }),
    SucceededFetchStats: ({ stats }) => ({
      model: modifyFields(model, { stats: () => StatsState.Loaded({ stats }) }),
    }),
    FailedFetchStats: () => ({
      model: modifyFields(model, { stats: () => StatsState.Unavailable() }),
    }),
  });

// VIEW

const SITE_URL = "https://just-be.dev/";

const navLink = (label: string, href: string, isCurrent: boolean, h: HtmlBuilder<Message>) =>
  h.a(
    [
      h.Href(href),
      h.Class(
        cn(
          "flex shrink-0 items-center px-[1ch] transition-[filter] duration-150 hover:invert focus-visible:invert focus-visible:outline-none",
          isCurrent ? "bg-background" : "bg-muted",
        ),
      ),
      ...(isCurrent ? [h.AriaCurrent("page")] : []),
    ],
    [h.span([h.Class("font-bold underline")], [label.slice(0, 1)]), label.slice(1)],
  );

/** The top bar from just-be.dev: tabs on the left, the name in the middle. */
const topBar = (h: HtmlBuilder<Message>) =>
  h.nav(
    [
      h.Class("fixed top-0 right-0 left-0 z-10 flex h-[1lh] items-center bg-muted"),
      h.AriaLabel("Main navigation"),
    ],
    [
      h.div(
        [h.Class("flex h-full")],
        [navLink("home", SITE_URL, false, h), navLink("traces", "/", true, h)],
      ),
      h.a(
        [
          h.Href(SITE_URL),
          h.AriaLabel("justin bennett"),
          h.Class(
            "ml-auto flex gap-[1ch] pr-[1ch] hover:invert focus-visible:invert focus-visible:outline-none lg:fixed lg:left-1/2 lg:-translate-x-1/2 lg:pr-0",
          ),
        ],
        [
          h.span([], [h.span([h.Class("font-bold")], ["just"]), "in"]),
          h.span([], [h.span([h.Class("font-bold")], ["be"]), "nnett"]),
        ],
      ),
    ],
  );

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: "~/traces · justin bennett",
  body: h.div(
    [h.Class("flex min-h-screen flex-col pt-[1lh] pb-[2lh]")],
    [
      topBar(h),
      h.main(
        [
          h.Id("main-content"),
          h.Tabindex(-1),
          h.Class(
            "mx-auto mt-[2lh] flex w-full max-w-4xl flex-col gap-[2lh] px-[2ch] focus:outline-none",
          ),
        ],
        [h.h1([h.Class("font-bold")], ["~/traces"]), activityView(model.stats, model.metric, h)],
      ),
    ],
  ),
});
