// Switching the rules pane on for someone who says yes. The pane is a Claude
// Code early-access feature that loads only when CLAUDE_CODE_ENABLE_FUNCTION_HOOKS
// is set. A plugin cannot set it, but the person's own settings file can, in
// its env block.
//
// So the first time Jev picks a rule in a session someone is attending, Claude
// is asked to put one question to them in Claude Code's own question box, and
// the PostToolUse hook applies the answer: yes adds the variable to
// ~/.claude/settings.json, "don't ask again" is remembered in the plugin's
// data directory, and "not now" asks again in a later session. /jev-rules:pane
// puts the same question at any time.

import { mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";

export const FLAG = "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS";
export const OFFER_FILE = "pane-offer.json";

export const ANSWERS = { yes: "Yes, turn it on", later: "Not now", never: "Don't ask again" };

/** The question, exactly as Claude passes it to AskUserQuestion. commands/pane.md carries the same text. */
export const QUESTION = {
  question: "Turn on the jev-rules pane? It lists every rule beside the conversation and lights up the ones Jev picks.",
  header: "Rules pane",
  multiSelect: false,
  options: [
    { label: ANSWERS.yes, description: `Adds "${FLAG}": "1" to the env block of ~/.claude/settings.json. It is an early-access Claude Code setting, and other installed plugins with panes load theirs too. Takes effect after a restart.` },
    { label: ANSWERS.later, description: "Nothing changes. jev-rules asks again in a later session." },
    { label: ANSWERS.never, description: "Nothing changes, and jev-rules does not ask again. /jev-rules:pane asks at any time." },
  ],
};

/** The instruction added to Claude's context when the question is due. */
export function offerInstruction() {
  return [
    "jev-rules has one question for the person, asked once. Before you start on the request, call the AskUserQuestion tool with exactly this input:",
    JSON.stringify({ questions: [QUESTION] }),
    "jev-rules applies the answer itself: do not edit any settings file or run any command for it. Then carry on with the request as usual.",
  ].join("\n");
}

/** True when an environment value switches something on: set, and not 0, false, no or off. */
export const isOn = (value) => typeof value === "string" && !/^\s*(0|false|no|off)?\s*$/i.test(value);

/** The person's own Claude Code settings file. */
export const settingsFile = (env, home) => join(env.CLAUDE_CONFIG_DIR || join(home, ".claude"), "settings.json");

/** A path as the person reads it: under their home, with ~. */
export function shortPath(path, home) {
  return path === home || path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path;
}

/** What the plugin remembers about the question; empty when unreadable. */
export function readOffer(dataDir) {
  try {
    const raw = JSON.parse(readFileSync(join(dataDir, OFFER_FILE), "utf8"));
    return { declined: raw?.declined === true, lastSession: typeof raw?.lastSession === "string" ? raw.lastSession : null };
  } catch {
    return { declined: false, lastSession: null };
  }
}

function writeOffer(dataDir, record) {
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, OFFER_FILE), JSON.stringify(record));
  } catch {
    // Unwritable: the question may come again, nothing worse.
  }
}

/**
 * Whether to ask this session: someone is at the keyboard, the pane is not
 * already switched on, the question was not asked this session nor declined
 * for good, and there is a data directory to remember the answer in.
 */
export function shouldOffer({ env, sessionId, dataDir }) {
  if (env.CLAUDE_CODE_SESSION_ATTENDED !== "1" || isOn(env[FLAG]) || !dataDir || !sessionId) return false;
  const offer = readOffer(dataDir);
  return !offer.declined && offer.lastSession !== sessionId;
}

/** Remembers that this session has been asked. */
export function markOffered(dataDir, sessionId) {
  writeOffer(dataDir, { ...readOffer(dataDir), lastSession: sessionId });
}

/**
 * Adds the flag to the env block of the settings file at `file`, keeping
 * everything else. A missing file is created. A file that is not a JSON
 * object, or whose env is not an object, is left alone. A symlinked file is
 * written through the link.
 *
 * @returns {"switched-on"|"already-on"|"unreadable"}
 */
export function switchOn(file) {
  let target = file;
  let settings = {};
  let mode = 0o600;
  try {
    target = realpathSync(file);
    const text = readFileSync(target, "utf8");
    mode = statSync(target).mode & 0o777;
    settings = text.trim() ? JSON.parse(text) : {};
  } catch (err) {
    if (err?.code !== "ENOENT") return "unreadable";
  }
  const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  if (!isObject(settings) || (settings.env !== undefined && !isObject(settings.env))) return "unreadable";
  if (settings.env?.[FLAG] === "1") return "already-on";
  const next = { ...settings, env: { ...settings.env, [FLAG]: "1" } };
  try {
    mkdirSync(dirname(target), { recursive: true });
    const tmp = `${target}.${randomUUID()}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode });
    renameSync(tmp, target);
  } catch {
    return "unreadable";
  }
  return "switched-on";
}

/** The person's answer to the pane question in a PostToolUse input, or null when it was another question. */
export function answerFrom(input) {
  if (input?.tool_name !== "AskUserQuestion") return null;
  for (const source of [input.tool_response, input.tool_input]) {
    const answer = source?.answers?.[QUESTION.question];
    if (typeof answer === "string") return answer;
  }
  return null;
}

/**
 * PostToolUse hook for AskUserQuestion: applies the answer to the pane
 * question. Returns context for Claude, and tells the person what happened
 * through `deps.say`.
 *
 * @param {object} input Parsed PostToolUse stdin.
 * @param {object} [deps] Test seams: env, home, say.
 */
export async function runAnswer(input, deps = {}) {
  const answer = answerFrom(input);
  // A typed answer is not one of the three: nothing to apply.
  if (!Object.values(ANSWERS).includes(answer)) return null;
  const env = deps.env ?? process.env;
  const home = deps.home ?? homedir();
  const say = deps.say ?? (() => {});
  const dataDir = env.CLAUDE_PLUGIN_DATA;
  const file = settingsFile(env, home);
  const shown = shortPath(file, home);
  if (answer === ANSWERS.yes) {
    const outcome = switchOn(file);
    if (outcome === "switched-on") say(`jev-rules: rules pane switched on in ${shown}. Restart Claude Code to see it, then type /rules.`);
    else if (outcome === "already-on") say(`jev-rules: the rules pane is already switched on in ${shown}. Restart Claude Code if /rules is missing.`);
    else say(`jev-rules: ${shown} could not be read as JSON, so nothing changed. To switch the pane on, add "${FLAG}": "1" to its env block.`);
  } else if (answer === ANSWERS.never) {
    if (dataDir) writeOffer(dataDir, { ...readOffer(dataDir), declined: true });
    say("jev-rules: the pane question will not come again. /jev-rules:pane asks it at any time.");
  } else if (answer === ANSWERS.later) {
    say("jev-rules: nothing changed. The pane question comes again in a later session.");
  }
  return "jev-rules has applied the person's answer to its pane question. Do not change any settings for it; carry on with the request.";
}
