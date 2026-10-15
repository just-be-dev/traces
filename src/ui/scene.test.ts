import { test } from "bun:test";
import { click, Command, expect, given, role, scene, text, title } from "foldkit/scene";
import { FetchStats } from "./command.ts";
import { stats } from "./fixture.testing.ts";
import { init, Message, Model, StatsState, update, view } from "./main.ts";

const loaded = Model.make({ ...init().model, stats: StatsState.Loaded({ stats }) });

test("loaded stats show the activity map, totals, and breakdowns", () => {
  scene(
    { update, view },
    given(loaded),
    expect(role("heading", { name: "57 model responses in the last year" })).toBeVisible(),
    expect(role("img", { name: /57 model responses on 5 days/ })).toBeVisible(),
    expect(title("Mon, Oct 12, 2026: 40 responses, 906K tokens, 3 sessions")).toHaveAttr(
      "data-level",
      "4",
    ),
    expect(title("Sat, Oct 10, 2026: no activity")).toHaveAttr("data-level", "0"),
    expect(text("Busiest day: Mon, Oct 12, 2026, 40 responses")).toBeVisible(),
    expect(text("3 days")).toBeVisible(),
    expect(text("claude-opus-5-5")).toBeVisible(),
    expect(text("unknown model")).toBeVisible(),
    expect(role("region", { name: "Top tools" })).toContainText("Bash"),
    expect(role("button", { name: "responses" })).toHaveAttr("aria-pressed", "true"),
    click(role("button", { name: "tokens" })),
    expect(role("button", { name: "tokens" })).toHaveAttr("aria-pressed", "true"),
    expect(title("Thu, Oct 1, 2026: 4 responses, 1.2K tokens, 1 session")).toHaveAttr(
      "data-level",
      "2",
    ),
  );
});

test("the homepage shows a placeholder while loading, with no sign-in", () => {
  scene(
    { update, view },
    given(init().model),
    expect(text("Loading activity…")).toBeVisible(),
    expect(role("link", { name: /sign in/i })).toBeAbsent(),
    expect(role("heading", { level: 1, name: "~/traces" })).toBeVisible(),
    expect(role("link", { name: "justin bennett" })).toHaveAttr("href", "https://just-be.dev/"),
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
    expect(role("heading", { name: "57 model responses in the last year" })).toBeVisible(),
  );
});
