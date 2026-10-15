import { defineMessageUnion } from "foldkit/message";
import { UsageStats } from "../usage.ts";
import { Metric } from "./domain/activity.ts";

export const Message = defineMessageUnion({
  ClickedRetry: {},
  SelectedMetric: { metric: Metric },
  SucceededFetchStats: { stats: UsageStats },
  FailedFetchStats: {},
});
export type Message = typeof Message.Type;
