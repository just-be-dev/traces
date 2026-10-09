import * as Schema from "effect/Schema";
import type { Document, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import { modifyFields } from "foldkit/struct";
import type * as Update from "foldkit/update";
import { button } from "@/components/ui/button";

// MODEL

export const Model = Schema.Struct({ details: Schema.Boolean });
export type Model = typeof Model.Type;

// MESSAGE

export const Message = defineMessageUnion({ ClickedShowSetup: {}, ClickedHideSetup: {} });
export type Message = typeof Message.Type;

// INIT

export const init = () => ({ model: Model.make({ details: false }) });

// UPDATE

export const update = (model: Model, message: Message) =>
  Message.match<Update.Return<Model, Message>>(message, {
    ClickedShowSetup: () => ({ model: modifyFields(model, { details: () => true }) }),
    ClickedHideSetup: () => ({ model: modifyFields(model, { details: () => false }) }),
  });

// VIEW

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: "Traces · agent event collection",
  body: h.main(
    [h.Class("mx-auto flex min-h-screen max-w-4xl flex-col justify-center gap-10 px-6 py-16")],
    [
      h.header(
        [h.Class("space-y-3")],
        [
          h.p(
            [h.Class("font-mono text-sm text-muted-foreground")],
            ["TRACES / AGENT OBSERVABILITY"],
          ),
          h.h1(
            [h.Class("text-4xl font-semibold tracking-tight")],
            ["See what your coding agents did."],
          ),
          h.p(
            [h.Class("text-muted-foreground")],
            [
              "Collect raw agent events. Search a session or tool through a single remote MCP endpoint. Keep the original payload, even when agents speak different formats.",
            ],
          ),
        ],
      ),
      h.section(
        [
          h.Class("rounded-xl border border-border bg-card p-6 shadow-sm"),
          h.AriaLabel("Trace service status"),
        ],
        [
          h.h2([h.Class("text-lg font-medium")], ["First slice: collect → inspect"]),
          h.p(
            [h.Class("mt-2 text-sm text-muted-foreground")],
            [
              "Events are stored in D1 with their raw payload and a small searchable projection. Access gates the remote API; Basin analytics comes later.",
            ],
          ),
          h.p(
            [h.Class("my-6 font-mono text-sm text-muted-foreground")],
            ["POST /api/events     GET /api/events?q=…     POST /mcp"],
          ),
          h.div(
            [h.Class("flex gap-3")],
            [
              model.details
                ? button(
                    { onClick: Message.ClickedHideSetup(), type: "button", variant: "outline" },
                    "Hide setup",
                    h,
                  )
                : button({ onClick: Message.ClickedShowSetup(), type: "button" }, "Show setup", h),
            ],
          ),
        ],
      ),
      model.details
        ? h.section(
            [
              h.Class("rounded-xl border border-border bg-card p-6 shadow-sm"),
              h.AriaLabel("Integration setup"),
            ],
            [
              h.h2([h.Class("text-lg font-medium")], ["Connect an agent"]),
              h.p(
                [h.Class("mt-3 text-muted-foreground")],
                [
                  "Configure a Cloudflare Access identity for MCP; use a separately provisioned service token for noninteractive hooks. Run the inspect_hooks tool before editing local agent settings.",
                ],
              ),
              h.p(
                [h.Class("mt-3 font-mono text-sm")],
                ["Pi · Claude Code · Codex / Amp: MCP only"],
              ),
            ],
          )
        : h.empty,
      h.p(
        [h.Class("text-sm text-muted-foreground")],
        ["Local prototype · No agent hooks are installed automatically."],
      ),
    ],
  ),
});
