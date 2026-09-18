// The whole decision, from hook input to the text Claude receives.
//
// Fail open is the rule: whenever Jev cannot answer (no key, timeout, network,
// HTTP error, unreadable reply) every rule is injected and the prompt goes
// through. The hook never blocks and never says anything on stderr.

import { homedir } from "node:os";
import { join } from "node:path";
import { readConfig, resolveEnv } from "./config.mjs";
import { askJev } from "./jev.mjs";
import { appendDebug } from "./log.mjs";
import { loadRules } from "./rules.mjs";

export const RULES_DIR = join(".claude", "jev-rules");
// Claude Code caps hook output at 10,000 characters and replaces anything
// larger with a file preview, which would lose every rule at once.
export const OUTPUT_BUDGET = 9000;

/**
 * Decides which rules apply. Pure apart from the Jev call.
 *
 * @returns {Promise<{selected: Array<{rule, p: number|undefined, why: string}>, all: Array<{rule, p: number|undefined, injected: boolean, why: string}>, outcome: string, backend: string|null, model: string, ms: number, attempts: number, truncated: boolean}>}
 */
export async function decide({ rules, prompt, config, fetch: fetchImpl }) {
  // A rule with no description cannot be judged, so it is always injected.
  const always = rules.filter((r) => r.always || !r.description);
  const judged = rules.filter((r) => !r.always && r.description);
  const base = { backend: config.backend, model: "none", ms: 0, attempts: 0, truncated: false };
  const entry = (rule, p, injected, why) => ({ rule, p, injected, why });

  const everything = (outcome, extra = {}) => {
    const all = rules.map((r) => entry(r, undefined, true, r.always ? "always" : !r.description ? "no-description" : "fail-open"));
    return { ...base, ...extra, outcome, all, selected: all };
  };

  if (!judged.length) {
    const all = rules.map((r) => entry(r, undefined, true, r.always ? "always" : "no-description"));
    return { ...base, outcome: "no-jev-needed", all, selected: all };
  }
  if (!config.key) return everything("fail-open:no-key");

  let answer;
  try {
    answer = await askJev({
      backend: config.backend,
      key: config.key,
      prompt,
      rules: judged,
      timeoutMs: config.timeoutMs,
      fetch: fetchImpl,
    });
  } catch (err) {
    return everything(`fail-open:${err?.reason ?? "error"}`, { attempts: err?.attempts ?? 0 });
  }

  const all = [
    ...always.map((r) => entry(r, undefined, true, r.always ? "always" : "no-description")),
    ...judged.map((r) => {
      const p = answer.probabilities.get(r.name);
      if (p === undefined) return entry(r, undefined, true, "missing"); // No answer for this rule: fail open for it.
      return entry(r, p, p >= config.threshold, "jev");
    }),
  ];
  return {
    ...base,
    model: answer.model,
    ms: answer.ms,
    attempts: answer.attempts,
    truncated: answer.truncated,
    outcome: "jev",
    all,
    selected: all.filter((e) => e.injected),
  };
}

/** Turns a decision into the text injected as additionalContext. */
export function render(decision, total) {
  const fixed = decision.selected.filter((e) => e.p === undefined);
  const judged = decision.selected.filter((e) => e.p !== undefined).sort((a, b) => b.p - a.p);
  let omitted = 0;
  const build = (chosen) => {
    const lines = [`Project rules that apply to this request (jev-rules, ${chosen.length} of ${total}):`];
    if (decision.outcome.startsWith("fail-open")) {
      lines.push(`(Jev was unavailable: ${decision.outcome.slice("fail-open:".length)}. All rules are included.)`);
    }
    for (const { rule } of chosen) lines.push("", `## ${rule.name}`, rule.body);
    if (omitted) lines.push("", `(${omitted} rule${omitted === 1 ? "" : "s"} omitted: over Claude Code's 10,000-character hook output limit)`);
    return lines.join("\n");
  };
  let text = build([...fixed, ...judged]);
  while (text.length > OUTPUT_BUDGET && judged.length) {
    judged.pop();
    omitted += 1;
    text = build([...fixed, ...judged]);
  }
  return text;
}

function formatLog(decision, sessionId, prompt) {
  const short = prompt.replace(/\s+/g, " ").slice(0, 80);
  const lines = [
    `${new Date().toISOString()} session=${sessionId ?? "-"} backend=${decision.backend ?? "none"} model=${decision.model} ms=${decision.ms} attempts=${decision.attempts} outcome=${decision.outcome} truncated=${decision.truncated ? "yes" : "no"} prompt=${JSON.stringify(short)}`,
  ];
  for (const { rule, p, injected, why } of decision.all) {
    const score = p === undefined ? why : `p=${p.toFixed(2)}`;
    lines.push(`  ${rule.name} ${score} injected=${injected ? "yes" : "no"}`);
  }
  return lines;
}

/**
 * Hook entry point. Returns the additionalContext text, or null when there is
 * nothing to inject.
 *
 * @param {object} input Parsed UserPromptSubmit stdin (prompt, cwd, session_id).
 * @param {object} [deps] Test seams: env, home, fetch, cwd.
 */
export async function run(input, deps = {}) {
  const prompt = typeof input?.prompt === "string" ? input.prompt : "";
  if (!prompt.trim()) return null;
  const baseEnv = deps.env ?? process.env;
  const home = deps.home ?? homedir();
  const projectDir = baseEnv.CLAUDE_PROJECT_DIR || (typeof input.cwd === "string" && input.cwd) || deps.cwd || process.cwd();

  const rules = loadRules(join(projectDir, RULES_DIR));
  if (!rules.length) return null;

  const config = readConfig(resolveEnv(baseEnv, projectDir, home));
  let decision;
  try {
    decision = await decide({ rules, prompt, config, fetch: deps.fetch ?? globalThis.fetch });
  } catch (err) {
    const all = rules.map((rule) => ({ rule, p: undefined, injected: true, why: "fail-open" }));
    decision = { outcome: `fail-open:${err?.reason ?? "error"}`, backend: config.backend, model: "none", ms: 0, attempts: 0, truncated: false, all, selected: all };
  }
  const context = render(decision, rules.length);
  if (config.debug) appendDebug(home, formatLog(decision, input.session_id, prompt));
  return context;
}
