import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Schema from "effect/Schema";
import { Command, Http } from "foldkit";
import { UsageStats } from "../usage.ts";
import { apiUrl } from "./api.ts";
import { Message } from "./message.ts";

export const FetchStats = Command.define("FetchStats", {
  messages: [Message.SucceededFetchStats, Message.FailedFetchStats],
  execute: Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.get(apiUrl("api/stats"), {
      headers: { accept: "application/json" },
    });
    if (response.status !== 200) return Message.FailedFetchStats();
    const stats = yield* Schema.decodeUnknownEffect(UsageStats)(yield* response.json);
    return Message.SucceededFetchStats({ stats });
  }).pipe(
    Effect.catch(() => Effect.succeed(Message.FailedFetchStats())),
    Effect.provide(Http.layer),
  ),
});
