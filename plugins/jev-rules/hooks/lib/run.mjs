// The whole decision for a prompt, from hook input to the text Claude
// receives, and the parts the edit hook (edit.mjs) shares with it: the Jev
// call, the rendering and the debug log.
//
// Fail open is the rule: whenever Jev cannot answer (no key, timeout, network,
// HTTP error, unreadable reply) every rule it was asked about is injected and
// the prompt goes through. Codebase map documents are only listed then, never
// included, since a whole map would crowd out the rules. The hook never blocks
// and never says anything on stderr.

import { homedir } from "node:os";
import { join } from "node:path";
import { readConfig, resolveEnv } from "./config.mjs";
import { askJev, instructionFor, mapInstructionFor, MAX_PROMPT_CHARS } from "./jev.mjs";
import { appendDebug } from "./log.mjs";
import { loadMap } from "./map.mjs";
import { loadRules } from "./rules.mjs";
import { readState, STATE_DIR, writeState } from "./state.mjs";

export const RULES_DIR = join(".claude", "jev-rules");
// Claude Code caps hook output at 10,000 characters and replaces anything
// larger with a file preview, which would lose every rule at once. Rules and
// map documents share this budget, rules first.
export const OUTPUT_BUDGET = 9000;
const OVER_LIMIT = "over Claude Code's 10,000-character hook output limit";

const entry = (rule, p, injected, why) => ({ rule, p, injected, why });

/** The project root: Claude Code's CLAUDE_PROJECT_DIR, else the directory the hook runs in. */
export function projectDirOf(input, env, cwd) {
  return env.CLAUDE_PROJECT_DIR || (typeof input?.cwd === "string" && input.cwd) || cwd || process.cwd();
}

/**
 * One Jev call about every item in `groups`, all of which have a description
 * to judge. A group is `{ prefix, instruction, items }`, as askJev takes it,
 * and `entries[i]` lists group i's items: each with its p when Jev answered,
 * and injected regardless when Jev could not answer for it. With nothing to
 * judge there is no call.
 */
export async function judge({ groups, state, config, fetch: fetchImpl }) {
  const base = { backend: config.backend, model: "none", ms: 0, attempts: 0 };
  const failOpen = (reason, attempts) => ({
    ...base,
    attempts,
    outcome: `fail-open:${reason}`,
    entries: groups.map((g) => g.items.map((item) => entry(item, undefined, true, "fail-open"))),
  });
  if (!groups.some((g) => g.items.length)) return { ...base, outcome: "no-jev-needed", entries: groups.map(() => []) };
  if (!config.key) return failOpen("no-key", 0);

  let answer;
  try {
    answer = await askJev({ backend: config.backend, key: config.key, state, groups, timeoutMs: config.timeoutMs, fetch: fetchImpl });
  } catch (err) {
    return failOpen(err?.reason ?? "error", err?.attempts ?? 0);
  }
  const entries = groups.map((g) =>
    g.items.map((item) => {
      const p = answer.probabilities.get(item);
      if (p === undefined) return entry(item, undefined, true, "missing"); // No answer for this one: fail open for it.
      return entry(item, p, p >= config.threshold, "jev");
    }),
  );
  return { ...base, model: answer.model, ms: answer.ms, attempts: answer.attempts, outcome: "jev", entries };
}

/**
 * Decides which rules apply to a prompt, and which map documents in `docs`
 * would help with it, in one Jev call. Pure apart from that call. `map` has
 * an entry per document, as `all` has per rule.
 *
 * @returns {Promise<{selected: Array<{rule, p: number|undefined, why: string}>, all: Array<{rule, p: number|undefined, injected: boolean, why: string}>, map: Array<{rule, p: number|undefined, injected: boolean, why: string}>, outcome: string, backend: string|null, model: string, ms: number, attempts: number, truncated: boolean}>}
 */
export async function decide({ rules, docs = [], prompt, config, fetch: fetchImpl }) {
  // A rule with no description cannot be judged, so it is always injected.
  const fixed = rules.filter((r) => r.always || !r.description).map((r) => entry(r, undefined, true, r.always ? "always" : "no-description"));
  const judged = rules.filter((r) => !r.always && r.description);
  const { entries, ...verdict } = await judge({
    groups: [
      { prefix: "r", instruction: instructionFor, items: judged },
      { prefix: "m", instruction: mapInstructionFor, items: docs },
    ],
    state: { request: prompt.slice(0, MAX_PROMPT_CHARS) },
    config,
    fetch: fetchImpl,
  });
  const all = [...fixed, ...entries[0]];
  // Only a request that went out can have carried a cut prompt.
  const truncated = verdict.attempts > 0 && prompt.length > MAX_PROMPT_CHARS;
  return { ...verdict, truncated, all, selected: all.filter((e) => e.injected), map: entries[1] };
}

/** The decision when something unexpected breaks: every rule in `rules` is injected and every document in `docs` listed. */
export function failOpenDecision(rules, config, err, docs = []) {
  const all = rules.map((rule) => entry(rule, undefined, true, "fail-open"));
  const map = docs.map((doc) => entry(doc, undefined, true, "fail-open"));
  return { outcome: `fail-open:${err?.reason ?? "error"}`, backend: config.backend, model: "none", ms: 0, attempts: 0, truncated: false, all, selected: all, map };
}

/**
 * Turns a decision into the text injected as additionalContext, and the rules
 * that text shows. `subject` is what the rules apply to; `failOpenNote` says
 * which rules a fail-open brought in.
 */
export function render(decision, total, { subject = "this request", failOpenNote = "All rules are included." } = {}) {
  const fixed = decision.selected.filter((e) => e.p === undefined);
  const judged = decision.selected.filter((e) => e.p !== undefined).sort((a, b) => b.p - a.p);
  let omitted = 0;
  const build = (chosen) => {
    const lines = [`Project rules that apply to ${subject} (jev-rules, ${chosen.length} of ${total}):`];
    if (decision.outcome.startsWith("fail-open")) {
      lines.push(`(Jev was unavailable: ${decision.outcome.slice("fail-open:".length)}. ${failOpenNote})`);
    }
    for (const { rule } of chosen) lines.push("", `## ${rule.name}`, rule.body);
    if (omitted) lines.push("", `(${omitted} rule${omitted === 1 ? "" : "s"} omitted: ${OVER_LIMIT})`);
    return lines.join("\n");
  };
  let chosen = [...fixed, ...judged];
  let text = build(chosen);
  while (text.length > OUTPUT_BUDGET && judged.length) {
    judged.pop();
    omitted += 1;
    chosen = [...fixed, ...judged];
    text = build(chosen);
  }
  return { text, shown: chosen.map((e) => e.rule) };
}

const pointer = (doc) => `- ${doc.path}: ${doc.description}`;

/**
 * The map section, in at most `room` characters. The documents Jev picked
 * come most likely first, each with its body while that fits and as a
 * one-line pointer to its file when it does not. A document Jev could not
 * judge only ever gets a pointer, so an outage lists the map instead of
 * pouring it into the context. When not even every pointer fits, the least
 * likely are cut and counted. Returns the text, empty when not even the
 * heading fits, and how each document went in: "yes" (its body) or
 * "pointer".
 */
export function renderMap(decision, total, room) {
  const selected = decision.map.filter((e) => e.injected).sort((a, b) => (b.p ?? -1) - (a.p ?? -1));
  const picked = new Set(selected.filter((e) => e.why === "jev").map((e) => e.rule));
  const docs = selected.map((e) => e.rule);
  const build = (bodies, listed) => {
    const pointers = listed.filter((doc) => !bodies.includes(doc));
    const lines = [`Codebase map documents relevant to this request (jev-rules, ${bodies.length + pointers.length} of ${total}):`];
    if (decision.outcome.startsWith("fail-open")) {
      lines.push(`(Jev was unavailable: ${decision.outcome.slice("fail-open:".length)}. Documents are listed, not included.)`);
    }
    for (const doc of bodies) lines.push("", `## ${doc.name}`, doc.body);
    const tooLong = pointers.filter((doc) => picked.has(doc));
    const unjudged = pointers.filter((doc) => !picked.has(doc));
    if (tooLong.length) lines.push("", "Too long to include; read these files if needed:", ...tooLong.map(pointer));
    if (unjudged.length) lines.push("", "Not judged; read these files if needed:", ...unjudged.map(pointer));
    const omitted = docs.length - listed.length;
    if (omitted) lines.push("", `(${omitted} document${omitted === 1 ? "" : "s"} omitted: ${OVER_LIMIT})`);
    return lines.join("\n");
  };
  // Every selected document is owed at least a pointer, so pointers come
  // first, and bodies only take room that no pointer needs.
  let listed = docs;
  while (listed.length && build([], listed).length > room) listed = listed.slice(0, -1);
  if (build([], listed).length > room) return { text: "", placed: new Map() };
  const bodies = [];
  if (listed.length === docs.length) {
    for (const doc of docs) {
      if (picked.has(doc) && build([...bodies, doc], docs).length <= room) bodies.push(doc);
    }
  }
  const placed = new Map(listed.map((doc) => [doc, bodies.includes(doc) ? "yes" : "pointer"]));
  return { text: build(bodies, listed), placed };
}

/**
 * Debug log lines for one decision. `tail` ends the summary line, such as
 * `prompt="..."`, and `placed` says how each map document went in, as
 * renderMap returns it.
 */
export function formatLog(decision, sessionId, event, tail, placed = new Map()) {
  const score = (p, why) => (p === undefined ? why : `p=${p.toFixed(2)}`);
  const lines = [
    `${new Date().toISOString()} session=${sessionId ?? "-"} event=${event} backend=${decision.backend ?? "none"} model=${decision.model} ms=${decision.ms} attempts=${decision.attempts} outcome=${decision.outcome} truncated=${decision.truncated ? "yes" : "no"} ${tail}`,
  ];
  for (const { rule, p, injected, why } of decision.all) {
    lines.push(`  ${rule.name} ${score(p, why)} injected=${injected ? "yes" : "no"}`);
  }
  for (const { rule: doc, p, why } of decision.map ?? []) {
    lines.push(`  map:${doc.name} ${score(p, why)} injected=${placed.get(doc) ?? "no"}`);
  }
  return lines;
}

/**
 * Prompt hook entry point. Returns the additionalContext text, or null when
 * there is nothing to inject.
 *
 * @param {object} input Parsed UserPromptSubmit stdin (prompt, cwd, session_id).
 * @param {object} [deps] Test seams: env, home, fetch, cwd, stateDir.
 */
export async function run(input, deps = {}) {
  const prompt = typeof input?.prompt === "string" ? input.prompt : "";
  if (!prompt.trim()) return null;
  const baseEnv = deps.env ?? process.env;
  const home = deps.home ?? homedir();
  const projectDir = projectDirOf(input, baseEnv, deps.cwd);
  const config = readConfig(resolveEnv(baseEnv, projectDir, home));

  const rules = loadRules(join(projectDir, RULES_DIR));
  const docs = config.map ? loadMap(projectDir) : [];
  if (!rules.length && !docs.length) return null;

  let decision;
  try {
    decision = await decide({ rules, docs, prompt, config, fetch: deps.fetch ?? globalThis.fetch });
  } catch (err) {
    decision = failOpenDecision(rules, config, err, docs);
  }
  const sections = [];
  let shown = [];
  if (rules.length) {
    const rendered = render(decision, rules.length);
    shown = rendered.shown;
    // Nothing applies: say nothing, rather than an empty heading on every prompt.
    if (shown.length) sections.push(rendered.text);
  }
  let placed = new Map();
  if (docs.length) {
    // Rules come first; the map gets the room they leave, less the blank line between.
    const room = OUTPUT_BUDGET - (sections.length ? sections[0].length + 2 : 0);
    const map = renderMap(decision, docs.length, room);
    placed = map.placed;
    if (map.text && placed.size) sections.push(map.text);
  }
  if (config.edits && rules.length) {
    // A prompt starts a new turn: the rules it shows replace the last turn's
    // list, and Jev's answers about files stay valid. Map documents are not
    // recorded; the edit hook never offers them.
    const stateDir = deps.stateDir ?? STATE_DIR;
    const { files } = readState(stateDir, input.session_id);
    writeState(stateDir, input.session_id, { injected: shown.map((rule) => rule.name), files });
  }
  if (config.debug) {
    const short = prompt.replace(/\s+/g, " ").slice(0, 80);
    appendDebug(home, formatLog(decision, input.session_id, "prompt", `prompt=${JSON.stringify(short)}`, placed));
  }
  return sections.join("\n\n") || null;
}
