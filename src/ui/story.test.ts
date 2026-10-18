import { expect, test } from "bun:test";
import { Command, given, message, model, story } from "foldkit/story";
import { FetchStats } from "./command.ts";
import { stats } from "./fixture.testing.ts";
import { init, Message, update } from "./main.ts";

test("the homepage fetches stats on load and shows them when they arrive", () => {
  const start = init();
  expect(start.model.stats._tag).toBe("Loading");
  expect(start.commands.map((command) => command.name)).toEqual([FetchStats.name]);
  story(
    update,
    given(start.model),
    message(Message.SucceededFetchStats({ stats })),
    model((value) => expect(value.stats).toEqual({ _tag: "Loaded", stats })),
    Command.expectNone(),
  );
});

test("an outage can be retried", () => {
  story(
    update,
    given(init().model),
    message(Message.FailedFetchStats()),
    model((value) => expect(value.stats._tag).toBe("Unavailable")),
    message(Message.ClickedRetry()),
    model((value) => expect(value.stats._tag).toBe("Loading")),
    Command.expectExact(FetchStats),
    Command.resolve(FetchStats, Message.SucceededFetchStats({ stats })),
    model((value) => expect(value.stats._tag).toBe("Loaded")),
  );
});
