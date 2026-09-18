#!/usr/bin/env node
// UserPromptSubmit hook. Reads the hook JSON from stdin, asks Jev which rules
// apply, prints the additionalContext envelope. Exit code is always 0 and
// stderr stays silent: a broken hook must never block or clutter a prompt.

import { readFileSync } from "node:fs";
import { run } from "./lib/run.mjs";

process.exitCode = 0;
const quiet = () => {};
process.on("uncaughtException", quiet);
process.on("unhandledRejection", quiet);

let input = {};
try {
  const raw = readFileSync(0, "utf8");
  input = raw.trim() ? JSON.parse(raw) : {};
} catch {
  input = {};
}

try {
  const context = await run(input);
  if (context) {
    process.stdout.write(
      JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context } }),
    );
  }
} catch {
  // Fail open: nothing to add, the prompt proceeds.
}
