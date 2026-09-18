// Runs the real hook script the way Claude Code does: JSON on stdin, JSON on
// stdout, exit 0. HOME points at an empty directory and every key variable is
// removed, so the test never reaches the network whatever the machine has set.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENTRY = new URL("../plugins/jev-rules/hooks/jev-rules.mjs", import.meta.url).pathname;

function runHook(stdin, cwd) {
  const home = mkdtempSync(join(tmpdir(), "jev-rules-home-"));
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  for (const key of ["JEV_API_KEY", "TYPESAFE_API_KEY", "AI_GATEWAY_API_KEY", "CLAUDE_PROJECT_DIR", "JEV_DEBUG"]) delete env[key];
  return spawnSync(process.execPath, [ENTRY], { input: stdin, cwd, env, encoding: "utf8", timeout: 15000 });
}

function projectWithRules() {
  const dir = mkdtempSync(join(tmpdir(), "jev-rules-project-"));
  const rulesDir = join(dir, ".claude", "jev-rules");
  mkdirSync(rulesDir, { recursive: true });
  writeFileSync(join(rulesDir, "a.md"), "---\ndescription: A things\n---\nA body\n");
  writeFileSync(join(rulesDir, "b.md"), "---\nalways: true\n---\nB body\n");
  return dir;
}

test("with no key the hook prints a valid envelope with every rule, exits 0 and says nothing on stderr", () => {
  const cwd = projectWithRules();
  const res = runHook(JSON.stringify({ session_id: "t", cwd, prompt: "hello" }), cwd);
  assert.equal(res.status, 0);
  assert.equal(res.stderr, "");
  const out = JSON.parse(res.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.match(out.hookSpecificOutput.additionalContext, /## a\nA body/);
  assert.match(out.hookSpecificOutput.additionalContext, /## b\nB body/);
});

test("with no rules directory the hook prints nothing and exits 0", () => {
  const cwd = mkdtempSync(join(tmpdir(), "jev-rules-empty-"));
  const res = runHook(JSON.stringify({ cwd, prompt: "hello" }), cwd);
  assert.equal(res.status, 0);
  assert.equal(res.stdout, "");
  assert.equal(res.stderr, "");
});

test("garbage on stdin never breaks the prompt", () => {
  const cwd = projectWithRules();
  for (const stdin of ["", "not json", "{\"prompt\": 42}"]) {
    const res = runHook(stdin, cwd);
    assert.equal(res.status, 0, `stdin=${JSON.stringify(stdin)}`);
    assert.equal(res.stderr, "");
    assert.equal(res.stdout, "");
  }
});
