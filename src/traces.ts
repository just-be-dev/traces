import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const Source = Schema.Union([
  Schema.Literal("pi"),
  Schema.Literal("claude-code"),
  Schema.Literal("codex"),
  Schema.Literal("amp"),
]);
export const Submission = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1)),
  source: Source,
  sessionId: Schema.String.check(Schema.isMinLength(1)),
  event: Schema.String.check(Schema.isMinLength(1)),
  occurredAt: Schema.String,
  raw: Schema.Json,
});
export type Submission = typeof Submission.Type;

export const Trace = Schema.Struct({
  ...Submission.fields,
  owner: Schema.String,
  summary: Schema.String,
});
export type Trace = typeof Trace.Type;

export class TraceStore extends Context.Service<
  TraceStore,
  {
    readonly insert: (trace: Trace) => Effect.Effect<boolean>;
    readonly search: (owner: string, query: string) => Effect.Effect<readonly Trace[]>;
  }
>()("traces/TraceStore") {}

export class Identity extends Context.Service<
  Identity,
  { readonly owner: Effect.Effect<string | null> }
>()("traces/Identity") {}

// The original payload is immutable; these fields are only a search projection.
export const normalize = (owner: string, input: Submission): Trace => {
  const raw = input.raw;
  const fields: Record<string, unknown> =
    typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const summary =
    typeof fields.tool_name === "string" || typeof fields.toolName === "string"
      ? String(fields.tool_name ?? fields.toolName)
      : input.event;
  return { ...input, owner, summary };
};
