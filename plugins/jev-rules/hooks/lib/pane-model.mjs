// What the rules pane shows, as plain data: the tree of rule and map files,
// which of them Claude has been given this session, and Jev's latest scores.
// No file or engine access here, so node --test covers it; hooks/pane.tsx
// reads the files and draws what these functions return.

/** Keys match the session record: "rule:<name>" and "map:<name>". */
export const keyOf = (kind, name) => `${kind}:${name}`;

/**
 * The rows of the tree, folders first within each level, then files, by name.
 *
 * @param {{kind: "rule"|"map", name: string}[]} items names are relative paths
 *   without ".md", such as "frontend/react"
 * @returns {{key: string, label: string, depth: number, isFolder: boolean, kind: string}[]}
 */
export function treeRows(items) {
  const rows = [];
  for (const kind of ["rule", "map"]) {
    const names = items.filter((i) => i.kind === kind).map((i) => i.name);
    if (kind === "map" && !names.length) continue;
    rows.push({ key: `head:${kind}`, label: kind === "rule" ? "rules" : "map", depth: 0, isFolder: true, kind });
    walk(names, "", 1, kind, rows);
  }
  return rows;
}

function walk(names, prefix, depth, kind, rows) {
  const here = names.filter((n) => n.startsWith(prefix)).map((n) => n.slice(prefix.length));
  const folders = [...new Set(here.filter((n) => n.includes("/")).map((n) => n.split("/")[0]))].sort();
  const files = here.filter((n) => !n.includes("/")).sort();
  for (const folder of folders) {
    rows.push({ key: `folder:${kind}:${prefix}${folder}`, label: `${folder}/`, depth, isFolder: true, kind });
    walk(names, `${prefix}${folder}/`, depth + 1, kind, rows);
  }
  for (const file of files) rows.push({ key: keyOf(kind, `${prefix}${file}`), label: file, depth, isFolder: false, kind });
}

/**
 * Reads the session record the hooks write. Picked means given to Claude this
 * session: the delivered map, plus this turn's rules (which is all there is
 * under JEV_RULES_REPEAT=1). Anything unreadable is an empty record.
 *
 * @param {string|null|undefined} text the record's JSON
 * @returns {{picked: Set<string>, scores: Record<string, {p: number, via: string, file?: string}>}}
 */
export function readRecord(text) {
  let raw = null;
  try {
    raw = text ? JSON.parse(text) : null;
  } catch {
    raw = null;
  }
  const picked = new Set();
  const scores = {};
  if (!raw || typeof raw !== "object") return { picked, scores };
  if (raw.delivered && typeof raw.delivered === "object") for (const key of Object.keys(raw.delivered)) picked.add(key);
  if (Array.isArray(raw.injected)) for (const name of raw.injected) if (typeof name === "string") picked.add(keyOf("rule", name));
  if (raw.scores && typeof raw.scores === "object") {
    for (const [key, s] of Object.entries(raw.scores)) {
      if (s && typeof s.p === "number" && s.p >= 0 && s.p <= 1) scores[key] = s;
    }
  }
  return { picked, scores };
}

/** The keys in `next` that were not in `before`: what just arrived, to flash. */
export function newlyPicked(before, next) {
  return [...next].filter((key) => !before.has(key));
}

/** "Jev picked 2 of 15", counting files only. */
export function headline(rows, picked) {
  const files = rows.filter((r) => !r.isFolder);
  const got = files.filter((r) => picked.has(r.key)).length;
  return `Jev picked ${got} of ${files.length}`;
}

/** A score as the pane prints it: "0.97", or "" when Jev has not judged it. */
export const scoreText = (score) => (score ? score.p.toFixed(2) : "");

/**
 * Whether the pane opens by itself on a pick: only when the setting allows it,
 * the layout docks panes beside the transcript, the window is wide enough, and
 * the person has not closed it this session.
 */
export function shouldAutoOpen({ setting, viewport, closedByPerson, isOpen, minColumns = 144 }) {
  if (setting !== "on-first-pick" || closedByPerson || isOpen) return false;
  return viewport?.isFullscreen === true && (viewport.columns ?? 0) >= minColumns;
}

/**
 * One row's text, fitted to the pane: indent, mark, name, and the score at the
 * right edge. A name too long for the room is cut with an ellipsis.
 */
export function fitRow({ depth, label, mark, score, columns }) {
  const left = `${"  ".repeat(depth)}${mark} `;
  const room = Math.max(4, columns - left.length - (score ? score.length + 1 : 0));
  const name = label.length > room ? `${label.slice(0, room - 1)}…` : label;
  if (!score) return `${left}${name}`;
  const gap = Math.max(1, columns - left.length - name.length - score.length);
  return `${left}${name}${" ".repeat(gap)}${score}`;
}
