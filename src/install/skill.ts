import * as Effect from "effect/Effect";
import piExtension from "./skill/install-traces/extensions/traces.ts?raw";
import claudeCode from "./skill/install-traces/references/claude-code.md?raw";
import codex from "./skill/install-traces/references/codex.md?raw";
import pi from "./skill/install-traces/references/pi.md?raw";
import uploader from "./skill/install-traces/scripts/traces.ts?raw";
import skillMarkdown from "./skill/install-traces/SKILL.md?raw";

/**
 * The `install-traces` Agent Skill, bundled into the Worker as text. It is served
 * verbatim over MCP (Skills extension `io.modelcontextprotocol/skills`, plus plain
 * resources for clients without it) and over public HTTP for byte-exact downloads.
 * Both carry the same manifest, so an agent can verify what it wrote to disk.
 */

export const SKILL_NAME = "install-traces";
export const SKILLS_EXTENSION = "io.modelcontextprotocol/skills";
/** Skill content changes only on deploy. */
export const SKILL_TTL_MS = 300_000;

export interface SkillFile {
  /** Relative to the skill root, e.g. `scripts/traces.ts`. */
  readonly path: string;
  readonly mimeType: string;
  readonly text: string;
}

const files: ReadonlyArray<SkillFile> = [
  { path: "SKILL.md", mimeType: "text/markdown", text: skillMarkdown },
  { path: "references/claude-code.md", mimeType: "text/markdown", text: claudeCode },
  { path: "references/codex.md", mimeType: "text/markdown", text: codex },
  { path: "references/pi.md", mimeType: "text/markdown", text: pi },
  { path: "scripts/traces.ts", mimeType: "text/x-typescript", text: uploader },
  { path: "extensions/traces.ts", mimeType: "text/x-typescript", text: piExtension },
];

export const skillRoot = `skill://${SKILL_NAME}`;
export const skillUri = (path: string) => `${skillRoot}/${path}`;

/** The file at a `skill://install-traces/...` URI, or undefined. */
export const fileAtUri = (uri: string) => files.find((file) => skillUri(file.path) === uri);

/** The file at a path relative to the skill root, or undefined. */
export const fileAtPath = (path: string) => files.find((file) => file.path === path);

/** Directories of the skill (`skill://install-traces/references`, ...), with their direct children. */
export const directoryAtUri = (uri: string) => {
  if (uri !== skillRoot && !uri.startsWith(`${skillRoot}/`)) return undefined;
  const prefix = uri === skillRoot ? "" : `${uri.slice(skillRoot.length + 1)}/`;
  const children = new Map<string, { uri: string; name: string; mimeType: string }>();
  for (const file of files) {
    if (!file.path.startsWith(prefix)) continue;
    const [name, ...rest] = file.path.slice(prefix.length).split("/");
    if (name === undefined) continue;
    const child = `${prefix}${name}`;
    children.set(child, {
      uri: skillUri(child),
      name,
      mimeType: rest.length > 0 ? "inode/directory" : file.mimeType,
    });
  }
  return children.size === 0 ? undefined : [...children.values()];
};

export const allSkillFiles = files;

/** Top-level `key: value` pairs of the SKILL.md YAML frontmatter. */
export const frontmatter = (markdown: string): Record<string, string> => {
  const block = markdown.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? "";
  const fields: Record<string, string> = {};
  for (const line of block.split("\n")) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (match?.[1] !== undefined && match[2] !== undefined) fields[match[1]] = match[2].trim();
  }
  return fields;
};

const hex = (buffer: ArrayBuffer) =>
  Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");

export interface ManifestEntry {
  readonly uri: string;
  readonly path: string;
  readonly digest: string;
  readonly sha256: string;
  readonly size: number;
}

/** SHA-256 and byte size of every served file, computed from the exact bytes served. */
export const skillManifest = Effect.fn("Install.manifest")(function* () {
  return yield* Effect.forEach(files, (file) =>
    Effect.promise(async (): Promise<ManifestEntry> => {
      const bytes = new TextEncoder().encode(file.text);
      const sha256 = hex(await crypto.subtle.digest("SHA-256", bytes));
      return {
        uri: skillUri(file.path),
        path: file.path,
        digest: `sha256:${sha256}`,
        sha256,
        size: bytes.length,
      };
    }),
  );
});

/** A `skills/list` / `skills/get` entry. */
export const skillEntry = Effect.fn("Install.skillEntry")(function* () {
  const manifest = yield* skillManifest();
  return {
    uri: skillUri("SKILL.md"),
    frontmatter: frontmatter(skillMarkdown),
    resources: manifest.map(({ uri, digest, size }) => ({ uri, digest, size })),
  };
});
