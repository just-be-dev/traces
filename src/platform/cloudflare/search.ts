import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  EventId,
  MAX_CONTENT_RESULTS,
  type Owner,
  searchText,
  type Trace,
  TraceIndex,
  TraceIndexError,
} from "../../traces.ts";

/**
 * AI Search instance holding one plain-text document per trace (see `searchText`).
 * Built-in storage is filled through the Items API, so uploads are indexed right
 * away instead of waiting for a source sync. The index is keyword-only BM25 with
 * the trigram tokenizer, which matches substrings such as file paths and
 * identifiers and bills as full-text queries. No embeddings are computed.
 * Changing the tokenizer, index method, or metadata schema reindexes everything.
 */
export const ContentSearch = Cloudflare.AI.SearchInstance("TraceContents", {
  type: "builtin",
  indexMethod: { keyword: true, vector: false },
  indexingOptions: { keywordTokenizer: "trigram" },
  retrievalOptions: { keywordMatchMode: "and" },
  customMetadata: [
    { fieldName: "owner", dataType: "text" },
    { fieldName: "event_id", dataType: "text" },
  ],
});

/** AI Search returns up to 50 chunks; a long trace can contribute several. */
const MAX_CHUNKS = 50;

/** The part of the native `ai_search` binding this adapter uses. */
export interface SearchInstanceBinding {
  search(params: {
    query: string;
    ai_search_options: {
      retrieval: {
        retrieval_type: "keyword";
        keyword_match_mode: "and";
        match_threshold: number;
        max_num_results: number;
        filters: { owner: string };
        metadata_only: boolean;
        return_on_failure: boolean;
      };
    };
  }): Promise<unknown>;
  readonly items: {
    upload(
      name: string,
      content: string,
      options: { metadata: { owner: string; event_id: string } },
    ): Promise<unknown>;
  };
}

/**
 * Item names are capped at 128 characters and event IDs are arbitrary strings, so
 * the name is a digest of `(owner, id)`. Uploads upsert by name, which makes
 * re-indexing a trace idempotent.
 */
export const documentName = Effect.fn("TraceIndex.documentName")(function* (
  owner: Owner,
  id: EventId,
) {
  const digest = yield* Effect.promise(() =>
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([owner, id]))),
  );
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0"));
  return `traces/${hex.join("")}.txt`;
});

const SearchResponse = Schema.Struct({
  chunks: Schema.Array(
    Schema.Struct({
      item: Schema.Struct({
        metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
      }),
    }),
  ),
});

const decodeEventId = Schema.decodeUnknownOption(EventId);

/** Event IDs in chunk order, deduplicated. Chunks without a usable `event_id` are skipped. */
const rankedEventIds = (response: typeof SearchResponse.Type) => {
  const ids = new Set<EventId>();
  for (const chunk of response.chunks) {
    const id = decodeEventId(chunk.item.metadata?.event_id);
    if (Option.isSome(id)) ids.add(id.value);
    if (ids.size === MAX_CONTENT_RESULTS) break;
  }
  return [...ids];
};

/**
 * Content index over AI Search. The query and document text are never logged or
 * put on spans. Failures, including a response that doesn't decode, become a
 * typed TraceIndexError.
 */
export const contentIndex = (raw: Effect.Effect<SearchInstanceBinding>) =>
  Layer.succeed(TraceIndex, {
    index: Effect.fn("TraceIndex.index")(function* (trace: Trace) {
      const search = yield* raw;
      const name = yield* documentName(trace.owner, trace.id);
      yield* Effect.tryPromise({
        try: () =>
          search.items.upload(name, searchText(trace), {
            metadata: { owner: trace.owner, event_id: trace.id },
          }),
        catch: (cause) => new TraceIndexError({ operation: "index", cause }),
      });
    }),
    search: Effect.fn("TraceIndex.search")(function* (owner, query) {
      const search = yield* raw;
      const response = yield* Effect.tryPromise({
        try: () =>
          search.search({
            query,
            ai_search_options: {
              retrieval: {
                retrieval_type: "keyword",
                keyword_match_mode: "and",
                // BM25 scores aren't comparable to vector similarity; with "and" every
                // returned chunk already contains all terms, so keep them all.
                match_threshold: 0,
                max_num_results: MAX_CHUNKS,
                // Owner-scoped in the index too; the store re-checks owner on read.
                filters: { owner },
                metadata_only: true,
                return_on_failure: false,
              },
            },
          }),
        catch: (cause) => new TraceIndexError({ operation: "search", cause }),
      });
      // Parse messages echo values such as event IDs, so they never reach the logs.
      const decoded = yield* Schema.decodeUnknownEffect(SearchResponse)(response).pipe(
        Effect.mapError(
          () =>
            new TraceIndexError({
              operation: "search",
              cause: new Error("AI Search returned an unexpected response shape"),
            }),
        ),
      );
      return rankedEventIds(decoded);
    }),
  });
