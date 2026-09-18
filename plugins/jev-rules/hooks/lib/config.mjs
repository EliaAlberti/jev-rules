// Configuration comes from the environment, `<project>/.env`, then
// `~/.jev-rules.env`. Earlier sources win, the same order jev-router uses.
// Nothing here mutates process.env: the merged result is returned, which keeps
// the hook testable.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";

export const DEFAULT_THRESHOLD = 0.6;
export const DEFAULT_TIMEOUT_MS = 2000;
export const MIN_TIMEOUT_MS = 100;
// The hook itself is given 10 s by hooks.json; the Jev deadline must fire first
// so the fail-open path (inject everything) still runs.
export const MAX_TIMEOUT_MS = 8000;

/** Merges env files under `base` without overriding anything already set. */
export function resolveEnv(base, projectDir, home) {
  const merged = { ...base };
  for (const file of [join(projectDir, ".env"), join(home, ".jev-rules.env")]) {
    let parsed;
    try {
      parsed = parseEnv(readFileSync(file, "utf8"));
    } catch {
      continue; // Missing or unreadable; the key may still come from elsewhere.
    }
    for (const [key, value] of Object.entries(parsed)) {
      if (merged[key] === undefined || merged[key] === "") merged[key] = value;
    }
  }
  return merged;
}

function number(value, fallback, { min, max }) {
  const n = Number(value);
  if (value === undefined || value === "" || !Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

const OFF = /^(0|false|no)$/i;

/**
 * @returns {{backend: "typesafe"|"vercel"|null, key: string|null, threshold: number, timeoutMs: number, debug: boolean, edits: boolean, map: boolean}}
 */
export function readConfig(env) {
  const direct = env.JEV_API_KEY || env.TYPESAFE_API_KEY || "";
  const gateway = env.AI_GATEWAY_API_KEY || "";
  let backend = null;
  let key = null;
  if (direct) {
    key = direct;
    backend = direct.startsWith("vck_") ? "vercel" : "typesafe";
  } else if (gateway) {
    key = gateway;
    backend = "vercel";
  }
  return {
    backend,
    key,
    threshold: number(env.JEV_RULES_THRESHOLD, DEFAULT_THRESHOLD, { min: 0, max: 1 }),
    timeoutMs: Math.round(number(env.JEV_RULES_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, { min: MIN_TIMEOUT_MS, max: MAX_TIMEOUT_MS })),
    debug: Boolean(env.JEV_DEBUG) && !OFF.test(env.JEV_DEBUG),
    edits: !OFF.test(env.JEV_RULES_EDITS ?? ""),
    map: !OFF.test(env.JEV_RULES_MAP ?? ""),
  };
}
