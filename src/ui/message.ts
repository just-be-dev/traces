import { defineMessageUnion } from "foldkit/message";
import { UsageStats } from "../usage.ts";

export const Message = defineMessageUnion({
  ClickedRetry: {},
  SucceededFetchStats: { stats: UsageStats },
  FailedFetchStats: {},
});
export type Message = typeof Message.Type;
