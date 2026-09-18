// Runs the real hook script the way Claude Code does: JSON on stdin, JSON on
// stdout, exit 0. HOME points at an empty directory and every key variable is
// removed, so the test never reaches the network whatever the machine has set.
// The temporary directory is a fresh one too, so session state stays inside
// the test.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENTRY = new URL("../plugins/jev-rules/hooks/jev-rules.mjs", import.meta.url).pathname;

function runHook(stdin, cwd, tmp = mkdtempSync(join(tmpdir(), "jev-rules-tmp-"))) {
  const home = mkdtempSync(join(tmpdir(), "jev-rules-home-"));
  const env = { ...process.env, HOME: home, USERPROFILE: home, TMPDIR: tmp, TMP: tmp, TEMP: tmp };
  for (const key of ["JEV_API_KEY", "TYPESAFE_API_KEY", "AI_GATEWAY_API_KEY", "CLAUDE_PROJECT_DIR", "JEV_DEBUG", "JEV_RULES_EDITS", "JEV_RULES_MAP"]) delete env[key];
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
  const res = runHook(JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "t", cwd, prompt: "hello" }), cwd);
  assert.equal(res.status, 0);
  assert.equal(res.stderr, "");
  const out = JSON.parse(res.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.match(out.hookSpecificOutput.additionalContext, /## a\nA body/);
  assert.match(out.hookSpecificOutput.additionalContext, /## b\nB body/);
});

test("a project with only a codebase-mapper map and no key gets a pointer to each document, exits 0 and says nothing on stderr", () => {
  const cwd = mkdtempSync(join(tmpdir(), "jev-rules-project-"));
  const info = join(cwd, ".claude", ".codebase-info");
  mkdirSync(info, { recursive: true });
  writeFileSync(join(info, "INDEX.md"), "# Map\n\n- [Architecture](architecture.md)\n");
  writeFileSync(join(info, "architecture.md"), "# Architecture\n\nLast Updated: 2026-09-13\n\nA plugin marketplace.\n");
  const res = runHook(JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "t", cwd, prompt: "hello" }), cwd);
  assert.equal(res.status, 0);
  assert.equal(res.stderr, "");
  assert.equal(
    JSON.parse(res.stdout).hookSpecificOutput.additionalContext,
    [
      "Codebase map documents relevant to this request (jev-rules, 1 of 1):",
      "(Jev was unavailable: no-key. Documents are listed, not included.)",
      "",
      "Not judged; read these files if needed:",
      "- .claude/.codebase-info/architecture.md: Architecture: A plugin marketplace.",
    ].join("\n"),
  );
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
  for (const stdin of ["", "not json", "{\"prompt\": 42}", "null", JSON.stringify({ hook_event_name: "Stop", cwd, prompt: "hello" })]) {
    const res = runHook(stdin, cwd);
    assert.equal(res.status, 0, `stdin=${JSON.stringify(stdin)}`);
    assert.equal(res.stderr, "");
    assert.equal(res.stdout, "");
  }
});

test("an edit gets a PreToolUse envelope with no permission decision, and a second edit in the turn gets nothing", () => {
  const cwd = projectWithRules();
  const tmp = mkdtempSync(join(tmpdir(), "jev-rules-tmp-"));
  const payload = JSON.stringify({
    hook_event_name: "PreToolUse",
    session_id: "spawned-edit",
    cwd,
    tool_name: "Edit",
    tool_input: { file_path: join(cwd, "src", "a.ts"), old_string: "x", new_string: "y" },
  });
  const first = runHook(payload, cwd, tmp);
  assert.equal(first.status, 0);
  assert.equal(first.stderr, "");
  const out = JSON.parse(first.stdout);
  assert.deepEqual(Object.keys(out), ["hookSpecificOutput"]);
  assert.deepEqual(Object.keys(out.hookSpecificOutput), ["hookEventName", "additionalContext"]);
  assert.equal(out.hookSpecificOutput.hookEventName, "PreToolUse");
  // No key, so the one judged rule comes in; the always rule belongs to the prompt.
  assert.match(out.hookSpecificOutput.additionalContext, /^Project rules that apply to src\/a\.ts \(jev-rules, 1 of 2\):\n\(Jev was unavailable: no-key\./);
  assert.match(out.hookSpecificOutput.additionalContext, /## a\nA body$/);

  const second = runHook(payload, cwd, tmp);
  assert.deepEqual([second.status, second.stdout, second.stderr], [0, "", ""]);
});
