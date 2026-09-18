// Reads the codebase map: documents that explain the project, of which Jev
// picks the few that help with a prompt. Two sources, merged:
//
//   .claude/jev-map/**/*.md          written for this plugin, with the same
//                                    frontmatter as rules
//   .claude/.codebase-info/**/*.md   written by Eigenwise's codebase-mapper,
//                                    no frontmatter, named codebase-info/...
//
// A document without a `description` gets one from its title and its first
// paragraph, which is how codebase-mapper documents open:
//
//   # Release and publishing
//
//   Last Updated: 2026-09-13
//
//   The marketplace manifests on `main` are delivery. ...

import { join, sep } from "node:path";
import { loadRules } from "./rules.mjs";

export const MAP_DIR = join(".claude", "jev-map");
export const CODEBASE_INFO_DIR = join(".claude", ".codebase-info");
export const DESCRIPTION_MAX = 300;

const FENCE = /^(```|~~~)/;
const HEADING = /^(#{1,6})(?:\s+(.*))?$/;
const LIST_ITEM = /^(?:[-*+]|\d{1,9}[.)])\s+/;
const LAST_UPDATED = /^[*_]*last updated\b/i;

/** `text` cut to `max` characters at the last space that fits, or mid-word when there is none. */
function cap(text, max) {
  if (text.length <= max) return text;
  const space = text.lastIndexOf(" ", max);
  return text.slice(0, space > 0 ? space : max);
}

/**
 * A description for a document that has none: its `# Title`, a colon and
 * its first paragraph or list item. Headings below the title, `Last Updated`
 * lines and fenced code are passed over. Whitespace is collapsed and the
 * result cut to 300 characters on a word boundary. A body with neither a
 * title nor prose is described by its own opening text.
 */
export function deriveDescription(body) {
  let title = "";
  const prose = [];
  let fenced = false;
  for (const raw of String(body).split("\n")) {
    const line = raw.trim();
    const fence = FENCE.test(line);
    if (fence) fenced = !fenced;
    const code = fence || fenced;
    const heading = !code && HEADING.exec(line);
    const item = !code && LIST_ITEM.exec(line);
    // A blank line, a heading, code or the next list item ends the first paragraph or item.
    if (prose.length && (!line || code || heading || item)) break;
    if (!line || code) continue;
    if (heading) {
      if (!title && heading[1] === "#") title = heading[2] ?? "";
      continue;
    }
    if (!prose.length && LAST_UPDATED.test(line)) continue;
    prose.push(item ? line.slice(item[0].length) : line);
  }
  const text = [title, prose.join(" ")].filter((part) => part.trim()).join(": ") || String(body);
  return cap(text.replace(/\s+/g, " ").trim(), DESCRIPTION_MAX);
}

/**
 * The documents under `<projectDir>/<dir>`, read by the rule loader. Each is
 * named `prefix` plus its path without `.md`, and carries `path`, its file
 * relative to the project with forward slashes. `always` is dropped: a map
 * document is only ever included because Jev picked it.
 *
 * @returns {Array<{name: string, description: string, applies: string|undefined, does_not_apply: string|undefined, body: string, path: string}>}
 */
export function loadDocs(projectDir, dir, prefix = "") {
  const base = dir.split(sep).join("/");
  return loadRules(join(projectDir, dir)).map((doc) => ({
    name: prefix + doc.name,
    description: doc.description || deriveDescription(doc.body),
    applies: doc.applies,
    does_not_apply: doc.does_not_apply,
    body: doc.body,
    path: `${base}/${doc.name}.md`,
  }));
}

/** Both sources, sorted by name. A missing directory adds nothing. */
export function loadMap(projectDir) {
  // INDEX.md is codebase-mapper's table of contents: links to the documents
  // that are already on the list, and nothing Claude would read on its own.
  const mapper = loadDocs(projectDir, CODEBASE_INFO_DIR, "codebase-info/").filter((doc) => !doc.path.endsWith("/INDEX.md"));
  return [...loadDocs(projectDir, MAP_DIR), ...mapper].sort((a, b) => a.name.localeCompare(b.name));
}
