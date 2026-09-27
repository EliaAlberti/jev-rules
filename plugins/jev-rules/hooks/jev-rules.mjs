#!/usr/bin/env node
// Entry point for every hook. Reads the hook JSON from stdin, hands it to the
// prompt hook (UserPromptSubmit), the edit hook (PreToolUse) or the answer to
// the pane question (PostToolUse), and prints the additionalContext envelope,
// with the line for the person as systemMessage. Exit code is always 0, stderr
// stays silent and no permission decision is ever returned: a broken hook must
// never block or clutter a prompt or an edit.

import { readFileSync } from "node:fs";
import { runEdit } from "./lib/edit.mjs";
import { runAnswer } from "./lib/pane-setup.mjs";
import { run, runSessionStart } from "./lib/run.mjs";

process.exitCode = 0;
const quiet = () => {};
process.on("uncaughtException", quiet);
process.on("unhandledRejection", quiet);

const HOOKS = new Map([
  ["UserPromptSubmit", run],
  ["PreToolUse", runEdit],
  ["SessionStart", runSessionStart],
  ["PostToolUse", runAnswer],
]);

let input = {};
try {
  const raw = readFileSync(0, "utf8");
  input = raw.trim() ? JSON.parse(raw) : {};
} catch {
  input = {};
}

try {
  // Claude Code always names the event. A payload without a name is taken as
  // a prompt, the only event this script handled before edits.
  const event = input?.hook_event_name ?? "UserPromptSubmit";
  const hook = HOOKS.get(event);
  let message = null;
  const context = hook ? await hook(input, { say: (text) => (message = text) }) : null;
  const output = {
    ...(message ? { systemMessage: message } : {}),
    ...(context ? { hookSpecificOutput: { hookEventName: event, additionalContext: context } } : {}),
  };
  if (message || context) process.stdout.write(JSON.stringify(output));
} catch {
  // Fail open: nothing to add, the prompt or edit proceeds.
}
