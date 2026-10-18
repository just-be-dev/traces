import * as Schema from "effect/Schema";
import type { Document, HtmlBuilder } from "foldkit/html";
import { defineTaggedUnion } from "foldkit/schema";
import { modifyFields } from "foldkit/struct";
import type * as Update from "foldkit/update";
import { UsageStats } from "../usage.ts";
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
  stats: StatsState,
});
export type Model = typeof Model.Type;

// INIT

export const init = () => ({
  model: Model.make({ stats: StatsState.Loading() }),
  commands: [FetchStats()],
});

// UPDATE

export const update = (model: Model, message: Message) =>
  Message.match<Update.Return<Model, Message>>(message, {
    ClickedRetry: () => ({
      model: modifyFields(model, { stats: () => StatsState.Loading() }),
      commands: [FetchStats()],
    }),
    SucceededFetchStats: ({ stats }) => ({
      model: modifyFields(model, { stats: () => StatsState.Loaded({ stats }) }),
    }),
    FailedFetchStats: () => ({
      model: modifyFields(model, { stats: () => StatsState.Unavailable() }),
    }),
  });

// VIEW

// NOTE: No site header here. At just-be.dev/traces the personal site's router
// injects its own header above this page, so one rendered here would duplicate it.
export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: "~/traces · justin bennett",
  body: h.div(
    [h.Class("flex min-h-screen flex-col pb-[2lh]")],
    [
      h.main(
        [
          h.Id("main-content"),
          h.Tabindex(-1),
          h.Class(
            "mx-auto mt-[2lh] flex w-full max-w-4xl flex-col gap-[2lh] px-[2ch] focus:outline-none",
          ),
        ],
        [h.h1([h.Class("font-bold")], ["~/traces"]), activityView(model.stats, h)],
      ),
    ],
  ),
});
