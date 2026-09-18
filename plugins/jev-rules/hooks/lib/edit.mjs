// The edit hook. When Claude is about to change a file, Jev is asked which
// rules apply to that file, and the ones Claude has not been given this turn
// are injected.
//
// Jev sees the file's path relative to the project, or only its base name
// when the file is outside the project: never its contents, never the edit.
// Answers are cached per file for the session, so a second edit to the same
// file costs no call. When Jev cannot answer, the rules it was asked about
// are injected, and that counts for the rest of the turn. Codebase map
// documents are not asked about here: the prompt that started the turn was.

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { readConfig, resolveEnv } from "./config.mjs";
import { criteriaFor, fileInstructionFor } from "./jev.mjs";
import { appendDebug } from "./log.mjs";
import { loadRules } from "./rules.mjs";
import { failOpenDecision, formatLog, judge, projectDirOf, render, RULES_DIR } from "./run.mjs";
import { readState, STATE_DIR, writeState } from "./state.mjs";

// Where each file-changing tool puts the path it is about to change. Current
// Claude Code has no MultiEdit, but older versions still send it.
const PATH_FIELD = new Map([
  ["Edit", "file_path"],
  ["Write", "file_path"],
  ["MultiEdit", "file_path"],
  ["NotebookEdit", "notebook_path"],
]);

// A rule file's path is the rule's name, and rule names stay on this machine.
const RULES_PREFIX = `${RULES_DIR.split(sep).join("/")}/`;

/**
 * What Jev is shown for `target`: its path relative to the project, with
 * forward slashes, or only its base name when it is outside the project.
 */
export function jevPath(target, projectDir) {
  const absolute = resolve(projectDir, target);
  const rel = relative(projectDir, absolute);
  const outside = !rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
  return outside ? basename(absolute) : rel.split(sep).join("/");
}

/**
 * A short hash of the question a rule puts to Jev about a file, so a rule
 * whose description or criteria change is judged again.
 */
export function cacheKey(rule) {
  const question = JSON.stringify([fileInstructionFor(rule.description), criteriaFor(rule) ?? null]);
  return createHash("sha256").update(question).digest("hex").slice(0, 12);
}

/**
 * Decides which of `candidates` apply to `file`. A rule with an answer in
 * `cache` skips Jev; the rest go in one call.
 */
export async function decideEdit({ candidates, file, cache, config, fetch: fetchImpl }) {
  const cached = [];
  const unknown = [];
  for (const rule of candidates) {
    const p = cache[cacheKey(rule)];
    if (p === undefined) unknown.push(rule);
    else cached.push({ rule, p, injected: p >= config.threshold, why: "cached" });
  }
  const { entries, ...verdict } = await judge({
    groups: [{ prefix: "r", instruction: fileInstructionFor, items: unknown }],
    state: { file },
    config,
    fetch: fetchImpl,
  });
  const all = [...cached, ...entries[0]];
  return { ...verdict, truncated: false, all, selected: all.filter((e) => e.injected) };
}

/**
 * Edit hook entry point. Returns the additionalContext text, or null when
 * there is nothing new to inject.
 *
 * @param {object} input Parsed PreToolUse stdin (tool_name, tool_input, cwd, session_id).
 * @param {object} [deps] Test seams: env, home, fetch, cwd, stateDir.
 */
export async function runEdit(input, deps = {}) {
  const field = PATH_FIELD.get(input?.tool_name);
  const target = field && input.tool_input?.[field];
  if (typeof target !== "string" || !target) return null;
  const baseEnv = deps.env ?? process.env;
  const home = deps.home ?? homedir();
  const projectDir = projectDirOf(input, baseEnv, deps.cwd);
  const config = readConfig(resolveEnv(baseEnv, projectDir, home));
  if (!config.edits) return null;

  const file = jevPath(target, projectDir);
  if (file.startsWith(RULES_PREFIX)) return null;
  const rules = loadRules(join(projectDir, RULES_DIR));
  const stateDir = deps.stateDir ?? STATE_DIR;
  const state = readState(stateDir, input.session_id);
  // Rules marked always, or with no description, already came with the prompt.
  const candidates = rules.filter((r) => !r.always && r.description && !state.injected.includes(r.name));
  if (!candidates.length) return null;

  const cache = Object.hasOwn(state.files, file) ? state.files[file] : {};
  let decision;
  try {
    decision = await decideEdit({ candidates, file, cache, config, fetch: deps.fetch ?? globalThis.fetch });
  } catch (err) {
    decision = failOpenDecision(candidates, config, err);
  }
  const { text, shown } = render(decision, rules.length, { subject: file, failOpenNote: "Every rule it could not judge is included." });

  // Only real answers are cached, so after a failure the next turn asks again.
  const answered = decision.all.filter((e) => e.why === "jev").map((e) => [cacheKey(e.rule), e.p]);
  writeState(stateDir, input.session_id, {
    injected: [...state.injected, ...shown.map((rule) => rule.name)],
    files: { ...state.files, [file]: { ...cache, ...Object.fromEntries(answered) } },
  });
  if (config.debug) {
    const fromCache = decision.all.filter((e) => e.why === "cached").length;
    appendDebug(home, formatLog(decision, input.session_id, "edit", `cached=${fromCache} file=${JSON.stringify(file)}`));
  }
  return shown.length ? text : null;
}
