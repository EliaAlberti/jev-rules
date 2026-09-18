// Claude Code owns the terminal while a hook runs, so nothing is ever written
// to stderr. When JEV_DEBUG is set, decisions go to ~/.jev-rules.log instead.

import { appendFileSync } from "node:fs";
import { join } from "node:path";

export const LOG_NAME = ".jev-rules.log";

export function appendDebug(home, lines) {
  try {
    appendFileSync(join(home, LOG_NAME), lines.map((line) => line + "\n").join(""));
  } catch {
    // A broken log file must never affect the prompt.
  }
}
