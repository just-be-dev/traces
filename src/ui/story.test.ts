import { expect, test } from "bun:test";
import { given, message, model, story } from "foldkit/story";
import { init, Message, update } from "./main.ts";

test("setup instructions are opt-in and reversible", () => {
  story(
    update,
    given(init().model),
    message(Message.ClickedShowSetup()),
    model((value) => expect(value.details).toBe(true)),
    message(Message.ClickedHideSetup()),
    model((value) => expect(value.details).toBe(false)),
  );
});
