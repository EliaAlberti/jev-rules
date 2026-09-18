// The whole decision for a prompt, from hook input to the text Claude
// receives, and the parts the edit hook (edit.mjs) shares with it: the Jev
// call, the rendering and the debug log.
//
// Fail open is the rule: whenever Jev cannot answer (no key, timeout, network,
// HTTP error, unreadable reply) every rule it was asked about is injected and
// the prompt goes through. The hook never blocks and never says anything on
// stderr.

import { homedir } from "node:os";
import { join } from "node:path";
import { readConfig, resolveEnv } from "./config.mjs";
import { askJev, instructionFor, MAX_PROMPT_CHARS } from "./jev.mjs";
import { appendDebug } from "./log.mjs";
import { loadRules } from "./rules.mjs";
import { readState, STATE_DIR, writeState } from "./state.mjs";

export const RULES_DIR = join(".claude", "jev-rules");
// Claude Code caps hook output at 10,000 characters and replaces anything
// larger with a file preview, which would lose every rule at once.
export const OUTPUT_BUDGET = 9000;

const entry = (rule, p, injected, why) => ({ rule, p, injected, why });

/** The project root: Claude Code's CLAUDE_PROJECT_DIR, else the directory the hook runs in. */
export function projectDirOf(input, env, cwd) {
  return env.CLAUDE_PROJECT_DIR || (typeof input?.cwd === "string" && input.cwd) || cwd || process.cwd();
}

/**
 * One Jev call about `rules`, all of which have a description to judge. Every
 * rule gets an entry: its p when Jev answered, and injected regardless when
 * Jev could not answer for it. With no rules there is no call.
 */
export async function judge({ rules, state, instruction, config, fetch: fetchImpl }) {
  const base = { backend: config.backend, model: "none", ms: 0, attempts: 0 };
  const failOpen = (reason, attempts) => ({
    ...base,
    attempts,
    outcome: `fail-open:${reason}`,
    entries: rules.map((r) => entry(r, undefined, true, "fail-open")),
  });
  if (!rules.length) return { ...base, outcome: "no-jev-needed", entries: [] };
  if (!config.key) return failOpen("no-key", 0);

  let answer;
  try {
    answer = await askJev({ backend: config.backend, key: config.key, state, instruction, rules, timeoutMs: config.timeoutMs, fetch: fetchImpl });
  } catch (err) {
    return failOpen(err?.reason ?? "error", err?.attempts ?? 0);
  }
  const entries = rules.map((r) => {
    const p = answer.probabilities.get(r.name);
    if (p === undefined) return entry(r, undefined, true, "missing"); // No answer for this rule: fail open for it.
    return entry(r, p, p >= config.threshold, "jev");
  });
  return { ...base, model: answer.model, ms: answer.ms, attempts: answer.attempts, outcome: "jev", entries };
}

/**
 * Decides which rules apply to a prompt. Pure apart from the Jev call.
 *
 * @returns {Promise<{selected: Array<{rule, p: number|undefined, why: string}>, all: Array<{rule, p: number|undefined, injected: boolean, why: string}>, outcome: string, backend: string|null, model: string, ms: number, attempts: number, truncated: boolean}>}
 */
export async function decide({ rules, prompt, config, fetch: fetchImpl }) {
  // A rule with no description cannot be judged, so it is always injected.
  const fixed = rules.filter((r) => r.always || !r.description).map((r) => entry(r, undefined, true, r.always ? "always" : "no-description"));
  const judged = rules.filter((r) => !r.always && r.description);
  const { entries, ...verdict } = await judge({
    rules: judged,
    state: { request: prompt.slice(0, MAX_PROMPT_CHARS) },
    instruction: instructionFor,
    config,
    fetch: fetchImpl,
  });
  const all = [...fixed, ...entries];
  // Only a request that went out can have carried a cut prompt.
  const truncated = verdict.attempts > 0 && prompt.length > MAX_PROMPT_CHARS;
  return { ...verdict, truncated, all, selected: all.filter((e) => e.injected) };
}

/** The decision when something unexpected breaks: every rule in `rules` is injected. */
export function failOpenDecision(rules, config, err) {
  const all = rules.map((rule) => entry(rule, undefined, true, "fail-open"));
  return { outcome: `fail-open:${err?.reason ?? "error"}`, backend: config.backend, model: "none", ms: 0, attempts: 0, truncated: false, all, selected: all };
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
    if (omitted) lines.push("", `(${omitted} rule${omitted === 1 ? "" : "s"} omitted: over Claude Code's 10,000-character hook output limit)`);
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

/** Debug log lines for one decision. `tail` ends the summary line, such as `prompt="..."`. */
export function formatLog(decision, sessionId, event, tail) {
  const lines = [
    `${new Date().toISOString()} session=${sessionId ?? "-"} event=${event} backend=${decision.backend ?? "none"} model=${decision.model} ms=${decision.ms} attempts=${decision.attempts} outcome=${decision.outcome} truncated=${decision.truncated ? "yes" : "no"} ${tail}`,
  ];
  for (const { rule, p, injected, why } of decision.all) {
    const score = p === undefined ? why : `p=${p.toFixed(2)}`;
    lines.push(`  ${rule.name} ${score} injected=${injected ? "yes" : "no"}`);
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

  const rules = loadRules(join(projectDir, RULES_DIR));
  if (!rules.length) return null;

  const config = readConfig(resolveEnv(baseEnv, projectDir, home));
  let decision;
  try {
    decision = await decide({ rules, prompt, config, fetch: deps.fetch ?? globalThis.fetch });
  } catch (err) {
    decision = failOpenDecision(rules, config, err);
  }
  const { text, shown } = render(decision, rules.length);
  if (config.edits) {
    // A prompt starts a new turn: the rules it shows replace the last turn's
    // list, and Jev's answers about files stay valid.
    const stateDir = deps.stateDir ?? STATE_DIR;
    const { files } = readState(stateDir, input.session_id);
    writeState(stateDir, input.session_id, { injected: shown.map((rule) => rule.name), files });
  }
  if (config.debug) {
    const short = prompt.replace(/\s+/g, " ").slice(0, 80);
    appendDebug(home, formatLog(decision, input.session_id, "prompt", `prompt=${JSON.stringify(short)}`));
  }
  return text;
}
