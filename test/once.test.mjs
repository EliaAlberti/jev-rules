// Once-per-session delivery: a rule or map document enters Claude's context
// one time per session, not on every matching prompt.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runEdit } from "../plugins/jev-rules/hooks/lib/edit.mjs";
import { run, runSessionStart } from "../plugins/jev-rules/hooks/lib/run.mjs";
import { readState } from "../plugins/jev-rules/hooks/lib/state.mjs";
import { fakeJev, home, names, project, THREE, TYPESAFE_ENV, writeRule } from "./helpers.mjs";

const stateDir = () => mkdtempSync(join(tmpdir(), "jev-rules-state-"));
const onlyPayments = (q) => (q.includes("payment") ? 0.9 : 0.1);

function session({ rules = THREE, env = TYPESAFE_ENV } = {}) {
  const cwd = project(rules);
  const calls = [];
  const deps = { env, home: home(), stateDir: stateDir() };
  return {
    cwd, calls, deps,
    prompt: (text, score = onlyPayments, id = "s1") => run({ prompt: text, cwd, session_id: id }, { ...deps, fetch: fakeJev(score, { calls }) }),
    edit: (path, score) => runEdit({ session_id: "s1", cwd, tool_name: "Edit", tool_input: { file_path: join(cwd, path) } }, { ...deps, fetch: fakeJev(score, { calls }) }),
    start: (source) => runSessionStart({ session_id: "s1", source }, deps),
  };
}

test("a rule is delivered once per session: the second matching prompt adds nothing and no longer asks about it", async () => {
  const s = session();
  assert.deepEqual(names(await s.prompt("fix the checkout total")), ["payments"]);
  assert.equal(await s.prompt("now fix the refund total"), null);
  assert.equal(Object.keys(s.calls[0].body.questions).length, 3);
  assert.equal(Object.keys(s.calls[1].body.questions).length, 2);
  assert.equal(JSON.stringify(s.calls[1].body).includes("payment"), false);
});

test("other rules can still arrive later in the session, and once everything is delivered Jev is not called at all", async () => {
  const s = session();
  await s.prompt("fix the checkout total");
  assert.deepEqual(names(await s.prompt("ship it", (q) => (q.includes("Deploying") ? 0.95 : 0.1))), ["deploy"]);
  assert.deepEqual(names(await s.prompt("write the docs", () => 0.9)), ["spelling"]);
  const before = s.calls.length;
  assert.equal(await s.prompt("anything at all", () => 1), null);
  assert.equal(s.calls.length, before);
});

test("sessions are separate: another session gets the rule again", async () => {
  const s = session();
  assert.deepEqual(names(await s.prompt("fix the checkout total")), ["payments"]);
  assert.deepEqual(names(await s.prompt("fix the checkout total", onlyPayments, "s2")), ["payments"]);
});

test("editing a rule's text makes it deliverable again; editing another rule does not", async () => {
  const s = session();
  await s.prompt("fix the checkout total");
  writeRule(s.cwd, "deploy", { description: "Deploying or releasing.", body: "deploy body, revised" });
  assert.equal(await s.prompt("fix the checkout total"), null);
  writeRule(s.cwd, "payments", { description: "Changing payment or checkout code.", body: "payments body, revised" });
  const again = await s.prompt("fix the checkout total");
  assert.deepEqual(names(again), ["payments"]);
  assert.match(again, /payments body, revised/);
});

test("always rules come once per session too", async () => {
  const s = session({ rules: { ...THREE, house: { always: true } } });
  assert.deepEqual(names(await s.prompt("fix the checkout total")), ["house", "payments"]);
  assert.equal(await s.prompt("rename a variable", () => 0.1), null);
});

test("after /clear or a compaction everything is deliverable again; a plain resume changes nothing", async () => {
  const s = session();
  await s.prompt("fix the checkout total");
  await s.start("resume");
  assert.equal(await s.prompt("fix the checkout total"), null);
  await s.start("compact");
  assert.deepEqual(names(await s.prompt("fix the checkout total")), ["payments"]);
  await s.start("clear");
  assert.deepEqual(names(await s.prompt("fix the checkout total")), ["payments"]);
});

test("a fail-open delivers every rule once, and the next prompt is silent without calling Jev", async () => {
  const s = session({ env: {} });
  assert.deepEqual(names(await s.prompt("x")), ["deploy", "payments", "spelling"]);
  assert.equal(await s.prompt("y"), null);
  assert.equal(s.calls.length, 0);
});

test("the edit hook skips a rule delivered by an earlier prompt in the session, even in a later turn", async () => {
  const s = session();
  await s.prompt("fix the checkout total");
  await s.prompt("unrelated", () => 0.1);
  const byPath = (q, state) => (q.includes("payment") && /checkout/.test(state.file ?? "") ? 0.95 : 0.05);
  assert.equal(await s.edit("src/checkout/discount.ts", byPath), null);
  const asked = JSON.stringify(s.calls.at(-1).body.questions);
  assert.equal(asked.includes("payment"), false);
});

test("a rule delivered by an edit is not delivered again by a later prompt", async () => {
  const s = session();
  const byPath = (q, state) => (q.includes("payment") && /checkout/.test(state.file ?? "") ? 0.95 : 0.05);
  assert.deepEqual(names(await s.edit("src/checkout/discount.ts", byPath)), ["payments"]);
  assert.equal(await s.prompt("fix the checkout total"), null);
});

test("map documents are delivered once per session as well", async () => {
  const s = session({ rules: {} });
  mkdirSync(join(s.cwd, ".claude", "jev-map"), { recursive: true });
  writeFileSync(join(s.cwd, ".claude", "jev-map", "checkout.md"), "---\ndescription: How checkout computes totals.\n---\nCHECKOUT DOC BODY\n");
  const first = await s.prompt("fix the checkout total", () => 0.9);
  assert.match(first, /## checkout\nCHECKOUT DOC BODY/);
  assert.equal(await s.prompt("fix the checkout total again", () => 0.9), null);
  assert.equal(s.calls.length, 1);
});

test("JEV_RULES_REPEAT=1 restores delivery on every matching prompt", async () => {
  const s = session({ env: { ...TYPESAFE_ENV, JEV_RULES_REPEAT: "1" } });
  assert.deepEqual(names(await s.prompt("fix the checkout total")), ["payments"]);
  assert.deepEqual(names(await s.prompt("fix the checkout total")), ["payments"]);
  assert.deepEqual(readState(s.deps.stateDir, "s1").delivered, {});
});

test("the debug log marks what was delivered earlier, and a prompt with nothing new", async () => {
  const s = session({ env: { ...TYPESAFE_ENV, JEV_DEBUG: "1" } });
  await s.prompt("fix the checkout total");
  await s.prompt("fix the refund total");
  await s.prompt("all three now", () => 0.9);
  await s.prompt("nothing left", () => 0.9);
  const log = readFileSync(join(s.deps.home, ".jev-rules.log"), "utf8");
  assert.match(log, /^  payments delivered-earlier injected=seen$/m);
  assert.match(log, /outcome=nothing-new /);
});

test("without a session id nothing is remembered, so delivery repeats rather than being lost", async () => {
  const s = session();
  assert.deepEqual(names(await s.prompt("fix the checkout total", onlyPayments, null)), ["payments"]);
  assert.deepEqual(names(await s.prompt("fix the checkout total", onlyPayments, null)), ["payments"]);
});

// Scores for the rules pane: Jev's latest answer per rule and map document.

test("the session record keeps Jev's latest score for each rule, from prompts and from edits", async () => {
  const s = session();
  await s.prompt("fix the checkout total");
  const afterPrompt = readState(s.deps.stateDir, "s1").scores;
  assert.deepEqual(afterPrompt["rule:payments"], { p: 0.9, via: "prompt" });
  assert.deepEqual(afterPrompt["rule:deploy"], { p: 0.1, via: "prompt" });
  const byPath = (q, state) => (q.includes("Deploying") && /release/.test(state.file ?? "") ? 0.95 : 0.05);
  await s.edit("scripts/release.sh", byPath);
  const afterEdit = readState(s.deps.stateDir, "s1").scores;
  assert.deepEqual(afterEdit["rule:deploy"], { p: 0.95, via: "edit", file: "scripts/release.sh" });
  assert.deepEqual(afterEdit["rule:payments"], { p: 0.9, via: "prompt" });
});

test("map documents get scores too, and a reset after /clear forgets them all", async () => {
  const s = session({ rules: {} });
  mkdirSync(join(s.cwd, ".claude", "jev-map"), { recursive: true });
  writeFileSync(join(s.cwd, ".claude", "jev-map", "checkout.md"), "---\ndescription: How checkout computes totals.\n---\nbody\n");
  await s.prompt("fix the checkout total", () => 0.8);
  assert.deepEqual(readState(s.deps.stateDir, "s1").scores["map:checkout"], { p: 0.8, via: "prompt" });
  await s.start("clear");
  assert.deepEqual(readState(s.deps.stateDir, "s1").scores, {});
});

test("a fail-open records no scores, and a malformed score in the file is dropped on read", async () => {
  const s = session({ env: {} });
  await s.prompt("x");
  assert.deepEqual(readState(s.deps.stateDir, "s1").scores, {});
  const file = join(s.deps.stateDir, "s1.json");
  const raw = JSON.parse(readFileSync(file, "utf8"));
  raw.scores = { "rule:a": { p: 2, via: "prompt" }, "rule:b": { p: 0.5, via: "guess" }, "rule:c": { p: 0.5, via: "edit", file: "x.ts" } };
  writeFileSync(file, JSON.stringify(raw));
  assert.deepEqual(readState(s.deps.stateDir, "s1").scores, { "rule:c": { p: 0.5, via: "edit", file: "x.ts" } });
});
