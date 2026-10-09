import { test } from "bun:test";
import { click, expect, given, role, scene, text } from "foldkit/scene";
import { init, update, view } from "./main.ts";

test("setup instructions expand and collapse", () => {
  scene(
    { update, view },
    given(init().model),
    expect(role("button", { name: "Show setup" })).toBeVisible(),
    click(role("button", { name: "Show setup" })),
    expect(text("Connect an agent")).toBeVisible(),
    click(role("button", { name: "Hide setup" })),
    expect(role("button", { name: "Show setup" })).toBeVisible(),
  );
});
