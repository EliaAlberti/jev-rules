// Reads rule files from a directory. A rule is a Markdown file with a small
// YAML frontmatter block:
//
//   ---
//   description: Changing code that computes prices, totals or refunds.
//   always: true        # optional; skip Jev and always inject
//   ---
//   Rule text that Claude sees when the rule applies.
//
// The parser handles only what the format needs: `key: value` lines, values
// optionally wrapped in single or double quotes, and `#` comment lines. No
// dependencies, no surprises.

import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

const FENCE = /^---[ \t]*$/;

function unquote(value) {
  const v = value.trim();
  if (v.length >= 2 && v[0] === '"' && v.at(-1) === '"') {
    return v.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  if (v.length >= 2 && v[0] === "'" && v.at(-1) === "'") {
    return v.slice(1, -1).replace(/''/g, "'");
  }
  return v;
}

/** Splits a rule file into its frontmatter fields and body. */
export function parseFrontmatter(text) {
  const lines = String(text).replace(/\r\n/g, "\n").split("\n");
  if (!FENCE.test(lines[0] ?? "")) return { data: {}, body: lines.join("\n").trim() };
  const end = lines.findIndex((line, i) => i > 0 && FENCE.test(line));
  if (end === -1) return { data: {}, body: lines.join("\n").trim() };
  const data = {};
  for (const line of lines.slice(1, end)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    if (key) data[key] = unquote(line.slice(colon + 1));
  }
  return { data, body: lines.slice(end + 1).join("\n").trim() };
}

function isTrue(value) {
  return typeof value === "string" && /^(true|yes)$/i.test(value.trim());
}

/**
 * Loads every `*.md` file in `dir`, sorted by name. A missing directory is an
 * empty rule set. Files with an empty body have nothing to inject and are
 * skipped.
 *
 * @returns {Array<{name: string, description: string, always: boolean, body: string}>}
 */
export function loadRules(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const rules = [];
  for (const entry of entries.filter((e) => e.isFile() && e.name.endsWith(".md")).sort((a, b) => a.name.localeCompare(b.name))) {
    let text;
    try {
      text = readFileSync(join(dir, entry.name), "utf8");
    } catch {
      continue;
    }
    const { data, body } = parseFrontmatter(text);
    if (!body) continue;
    rules.push({
      name: basename(entry.name, ".md"),
      description: typeof data.description === "string" ? data.description.trim() : "",
      always: isTrue(data.always),
      body,
    });
  }
  return rules;
}
