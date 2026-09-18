#!/usr/bin/env node
// Entry point for both hooks. Reads the hook JSON from stdin, hands it to the
// prompt hook (UserPromptSubmit) or the edit hook (PreToolUse), and prints the
// additionalContext envelope. Exit code is always 0, stderr stays silent and
// no permission decision is ever returned: a broken hook must never block or
// clutter a prompt or an edit.

import { readFileSync } from "node:fs";
import { runEdit } from "./lib/edit.mjs";
import { run, runSessionStart } from "./lib/run.mjs";

process.exitCode = 0;
const quiet = () => {};
process.on("uncaughtException", quiet);
process.on("unhandledRejection", quiet);

const HOOKS = new Map([
  ["UserPromptSubmit", run],
  ["PreToolUse", runEdit],
  ["SessionStart", runSessionStart],
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
  const context = hook ? await hook(input) : null;
  if (context) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: context } }));
  }
} catch {
  // Fail open: nothing to add, the prompt or edit proceeds.
}
