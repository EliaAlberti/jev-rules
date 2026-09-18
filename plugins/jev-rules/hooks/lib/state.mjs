// Per-session memory shared by the two hooks: which rules Claude has been
// given this turn, and Jev's answers for each file, so the edit hook neither
// repeats a rule nor asks twice about the same file. One small JSON file per
// session in the system temp directory:
//
//   { "injected": ["payments"], "files": { "src/checkout.ts": { "<cacheKey>": 0.93 } } }
//
// Any failure reads as an empty state. The worst that costs is a repeated
// rule or an extra Jev call, never a blocked prompt or edit.

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const STATE_DIR = join(tmpdir(), "jev-rules");
export const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// Claude Code's session ids are UUIDs. Anything else could reach outside the
// directory, so it gets no state at all.
const SESSION_ID = /^[\w-]{1,128}$/;

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isScore = (p) => typeof p === "number" && p >= 0 && p <= 1;

function stateFile(dir, sessionId) {
  return typeof sessionId === "string" && SESSION_ID.test(sessionId) ? join(dir, `${sessionId}.json`) : null;
}

/** The session's state; empty when the file is missing, unreadable or malformed. */
export function readState(dir, sessionId) {
  const file = stateFile(dir, sessionId);
  let raw = null;
  try {
    if (file) raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    // Missing or corrupt: start again.
  }
  if (!isRecord(raw)) return { injected: [], files: {} };
  // fromEntries rather than assignment, so a file called __proto__ stays an ordinary key.
  const files = Object.fromEntries(
    Object.entries(isRecord(raw.files) ? raw.files : {})
      .filter(([, answers]) => isRecord(answers))
      .map(([path, answers]) => [path, Object.fromEntries(Object.entries(answers).filter(([, p]) => isScore(p)))]),
  );
  const injected = Array.isArray(raw.injected) ? raw.injected.filter((name) => typeof name === "string") : [];
  return { injected, files };
}

/**
 * Saves the session's state through a temporary file and a rename, so a
 * reader never sees half a file. Hooks running at the same time can lose each
 * other's update, which costs a repeated rule or an extra call and nothing
 * more.
 */
export function writeState(dir, sessionId, state) {
  const file = stateFile(dir, sessionId);
  if (!file) return;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const created = !existsSync(file);
    const tmp = `${file}.${randomUUID()}.tmp`;
    writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    renameSync(tmp, file);
    if (created) sweep(dir);
  } catch {
    // A temporary file left behind is swept with the old state files.
  }
}

/** Deletes files untouched for a week. Runs once per session, when its state file is created. */
function sweep(dir) {
  const cutoff = Date.now() - MAX_AGE_MS;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    try {
      if (statSync(path).mtimeMs < cutoff) rmSync(path, { force: true });
    } catch {
      // Gone already, or a directory: leave it.
    }
  }
}
