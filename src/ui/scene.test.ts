import { test } from "bun:test";
import { click, Command, expect, given, role, scene, text, title } from "foldkit/scene";
import { FetchStats } from "./command.ts";
import { stats } from "./fixture.testing.ts";
import { init, Message, Model, StatsState, update, view } from "./main.ts";

const loaded = Model.make({ ...init().model, stats: StatsState.Loaded({ stats }) });

test("loaded stats show the token map, totals, and breakdowns", () => {
  scene(
    { update, view },
    given(loaded),
    expect(role("heading", { name: "918.9K tokens in the last year" })).toBeVisible(),
    expect(role("img", { name: /918.9K tokens on 5 days/ })).toBeVisible(),
    expect(title("Mon, Oct 12, 2026: 40 responses, 906K tokens, 3 sessions")).toHaveAttr(
      "data-level",
      "4",
    ),
    expect(title("Sat, Oct 10, 2026: no activity")).toHaveAttr("data-level", "0"),
    expect(title("Thu, Oct 1, 2026: 4 responses, 1.2K tokens, 1 session")).toHaveAttr(
      "data-level",
      "2",
    ),
    expect(text("Busiest day: Mon, Oct 12, 2026, 906K tokens")).toBeVisible(),
    expect(text("3 days")).toBeVisible(),
    expect(text("claude-opus-5-5")).toBeVisible(),
    expect(text("unknown model")).toBeVisible(),
    expect(role("region", { name: "Top tools" })).toBeAbsent(),
    expect(role("group", { name: "Color days by" })).toBeAbsent(),
    expect(role("region", { name: "Time of day" })).toBeVisible(),
  );
});

test("the homepage shows a placeholder while loading, with no sign-in or site header", () => {
  scene(
    { update, view },
    given(init().model),
    expect(text("Loading activity…")).toBeVisible(),
    expect(role("link", { name: /sign in/i })).toBeAbsent(),
    expect(role("heading", { level: 1, name: "~/traces" })).toBeVisible(),
    expect(role("navigation")).toBeAbsent(),
    expect(role("main")).toHaveAttr("id", "main-content"),
    expect(text("Connect an agent")).toBeAbsent(),
  );
});

test("an outage offers a retry that loads the stats", () => {
  scene(
    { update, view },
    given(Model.make({ ...init().model, stats: StatsState.Unavailable() })),
    click(role("button", { name: "Try again" })),
    expect(text("Loading activity…")).toBeVisible(),
    Command.resolve(FetchStats, Message.SucceededFetchStats({ stats })),
    expect(role("heading", { name: "918.9K tokens in the last year" })).toBeVisible(),
  );
});
