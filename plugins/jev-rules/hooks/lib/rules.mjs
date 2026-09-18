// Reads rule files from a directory tree. A rule is a Markdown file with a
// small YAML frontmatter block:
//
//   ---
//   description: Changing code that computes prices, totals or refunds.
//   applies: The change alters how an amount is calculated.
//   does_not_apply: Only the wording around a price changes.
//   always: true        # optional; skip Jev and always inject
//   ---
//   Rule text that Claude sees when the rule applies.
//
// `applies` and `does_not_apply` are optional. They tell Jev what a yes and a
// no mean when the description alone leaves the boundary unclear.
//
// The parser handles only what the format needs: `key: value` lines, values
// optionally wrapped in single or double quotes, and `#` comment lines. No
// dependencies, no surprises.

import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";

const FENCE = /^---[ \t]*$/;

// Symlinked directories are followed, so a link back up the tree must not
// loop: each real directory is read once, and never deeper than this.
const MAX_DEPTH = 8;

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

/** A trimmed field value, or undefined when the field is missing or blank. */
function trimmed(value) {
  return (typeof value === "string" && value.trim()) || undefined;
}

/**
 * Every `*.md` file under `dir`, named by its path relative to `dir` without
 * the extension, with `/` between parts on every platform.
 */
function ruleFiles(dir) {
  const files = [];
  const seen = new Set();
  const walk = (path, prefix, depth) => {
    let entries;
    try {
      const real = realpathSync(path);
      if (seen.has(real)) return;
      seen.add(real);
      entries = readdirSync(path, { withFileTypes: true });
    } catch {
      return;
    }
    // Sorted so that a directory reachable by two paths always gets the same name.
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".")) continue;
      const child = join(path, entry.name);
      let kind = entry;
      if (entry.isSymbolicLink()) {
        try {
          kind = statSync(child);
        } catch {
          continue; // A dangling or looping link.
        }
      }
      if (kind.isDirectory() && depth < MAX_DEPTH) walk(child, `${prefix}${entry.name}/`, depth + 1);
      else if (kind.isFile() && entry.name.endsWith(".md")) files.push({ path: child, name: prefix + entry.name.slice(0, -3) });
    }
  };
  walk(dir, "", 0);
  return files;
}

/**
 * Loads every `*.md` file under `dir`, subdirectories included, sorted by
 * name. A rule in a subdirectory is named by its path, such as
 * `frontend/react`. Symlinks are followed. Files and directories whose names
 * start with a dot are skipped, and so are files with an empty body, which
 * have nothing to inject. A missing directory is an empty rule set.
 *
 * @returns {Array<{name: string, description: string, applies: string|undefined, does_not_apply: string|undefined, always: boolean, body: string}>}
 */
export function loadRules(dir) {
  const rules = [];
  for (const { path, name } of ruleFiles(dir)) {
    let text;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    const { data, body } = parseFrontmatter(text);
    if (!body) continue;
    rules.push({
      name,
      description: trimmed(data.description) ?? "",
      applies: trimmed(data.applies),
      does_not_apply: trimmed(data.does_not_apply),
      always: isTrue(data.always),
      body,
    });
  }
  return rules.sort((a, b) => a.name.localeCompare(b.name));
}
