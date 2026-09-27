// The line naming what Claude was given, and switching the rules pane on: the
// question, when it comes, and what each answer changes.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfig } from "../plugins/jev-rules/hooks/lib/config.mjs";
import { runEdit } from "../plugins/jev-rules/hooks/lib/edit.mjs";
import { ANSWERS, FLAG, isOn, markOffered, offerInstruction, QUESTION, readOffer, runAnswer, shortPath, shouldOffer, switchOn } from "../plugins/jev-rules/hooks/lib/pane-setup.mjs";
import { picksMessage, run } from "../plugins/jev-rules/hooks/lib/run.mjs";
import { fakeJev, home, project, THREE, TYPESAFE_ENV } from "./helpers.mjs";

const temp = (prefix) => mkdtempSync(join(tmpdir(), prefix));
const rule = (name) => ({ name, body: `${name} body` });
const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));

// --- the line under a prompt ----------------------------------------------

test("the line names each rule and document Claude got, with Jev's score, most likely first as rendered", () => {
  const [pay, tests, style, checkout] = [rule("payments"), rule("tests"), rule("style"), rule("checkout")];
  const decision = {
    outcome: "jev",
    all: [
      { rule: style, p: undefined, injected: true, why: "always" },
      { rule: pay, p: 0.973, injected: true, why: "jev" },
      { rule: tests, p: 0.91, injected: true, why: "jev" },
    ],
    map: [{ rule: checkout, p: 0.88, injected: true, why: "jev" }],
  };
  assert.equal(picksMessage(decision, [style, pay, tests], new Map([[checkout, "yes"]])), "jev-rules: Jev gave Claude: style (always), payments 0.97, tests 0.91, map checkout 0.88");
  assert.equal(picksMessage(decision, [pay], new Map(), "src/checkout.ts"), "jev-rules: Jev gave Claude for src/checkout.ts: payments 0.97");
});

test("the line says nothing when Claude got nothing, and lists six items then a count", () => {
  assert.equal(picksMessage({ outcome: "jev", all: [], map: [] }, [], new Map()), null);
  const many = Array.from({ length: 9 }, (_, i) => rule(`r${i}`));
  const decision = { outcome: "jev", all: many.map((r) => ({ rule: r, p: 0.9, injected: true, why: "jev" })), map: [] };
  assert.equal(picksMessage(decision, many), "jev-rules: Jev gave Claude: r0 0.90, r1 0.90, r2 0.90, r3 0.90, r4 0.90, r5 0.90, 3 more");
});

test("when Jev is unavailable the line says so and counts the rules Claude got unjudged", () => {
  const rules = [rule("a"), rule("b")];
  const decision = { outcome: "fail-open:timeout", all: rules.map((r) => ({ rule: r, p: undefined, injected: true, why: "fail-open" })), map: [] };
  assert.equal(picksMessage(decision, rules), "jev-rules: Jev was unavailable (timeout), so Claude got 2 rules unjudged");
});

test("the prompt and edit hooks pass the line to say, and show_picks off keeps it quiet", async () => {
  const dir = project(THREE);
  const score = (instructions) => (instructions.includes("payment") ? 0.95 : 0.05);
  const lines = [];
  const env = { ...TYPESAFE_ENV };
  await run({ prompt: "fix checkout", session_id: "say-1", cwd: dir }, { env, home: home(), fetch: fakeJev(score), stateDir: temp("jev-rules-state-"), say: (m) => lines.push(m) });
  assert.deepEqual(lines, ["jev-rules: Jev gave Claude: payments 0.95"]);

  await runEdit(
    { tool_name: "Edit", tool_input: { file_path: join(dir, "src", "pay.ts") }, session_id: "say-2", cwd: dir },
    { env, home: home(), fetch: fakeJev(score), stateDir: temp("jev-rules-state-"), say: (m) => lines.push(m) },
  );
  assert.equal(lines[1], "jev-rules: Jev gave Claude for src/pay.ts: payments 0.95");

  for (const off of [{ CLAUDE_PLUGIN_OPTION_SHOW_PICKS: "off" }, { JEV_RULES_SHOW_PICKS: "0" }]) {
    const quiet = [];
    const context = await run({ prompt: "fix checkout", session_id: "quiet", cwd: dir }, { env: { ...env, ...off }, home: home(), fetch: fakeJev(score), stateDir: temp("jev-rules-state-"), say: (m) => quiet.push(m) });
    assert.match(context, /## payments/);
    assert.deepEqual(quiet, []);
  }
});

test("show_picks is on unless set to off, 0, false or no", () => {
  assert.equal(readConfig({}).showPicks, true);
  assert.equal(readConfig({ CLAUDE_PLUGIN_OPTION_SHOW_PICKS: "on" }).showPicks, true);
  for (const v of ["off", "0", "false", "No"]) assert.equal(readConfig({ CLAUDE_PLUGIN_OPTION_SHOW_PICKS: v }).showPicks, false, v);
});

// --- when the question comes -----------------------------------------------

test("the question comes once per session, only to someone at the keyboard, and not after a no for good", () => {
  const dataDir = temp("jev-rules-data-");
  const attended = { CLAUDE_CODE_SESSION_ATTENDED: "1" };
  assert.equal(shouldOffer({ env: attended, sessionId: "s1", dataDir }), true);
  assert.equal(shouldOffer({ env: { CLAUDE_CODE_SESSION_ATTENDED: "0" }, sessionId: "s1", dataDir }), false);
  assert.equal(shouldOffer({ env: {}, sessionId: "s1", dataDir }), false);
  assert.equal(shouldOffer({ env: { ...attended, [FLAG]: "1" }, sessionId: "s1", dataDir }), false);
  assert.equal(shouldOffer({ env: attended, sessionId: "s1", dataDir: undefined }), false);
  markOffered(dataDir, "s1");
  assert.equal(shouldOffer({ env: attended, sessionId: "s1", dataDir }), false);
  assert.equal(shouldOffer({ env: attended, sessionId: "s2", dataDir }), true);
  writeFileSync(join(dataDir, "pane-offer.json"), JSON.stringify({ declined: true }));
  assert.equal(shouldOffer({ env: attended, sessionId: "s3", dataDir }), false);
});

test("the first prompt that gives Claude a rule carries the question; a prompt that gives nothing does not", async () => {
  const dir = project(THREE);
  const dataDir = temp("jev-rules-data-");
  const env = { ...TYPESAFE_ENV, CLAUDE_CODE_SESSION_ATTENDED: "1", CLAUDE_PLUGIN_DATA: dataDir };
  const stateDir = temp("jev-rules-state-");
  const none = await run({ prompt: "hello", session_id: "q", cwd: dir }, { env, home: home(), fetch: fakeJev(() => 0.01), stateDir });
  assert.equal(none, null);
  assert.equal(readOffer(dataDir).lastSession, null);
  const first = await run({ prompt: "fix checkout", session_id: "q", cwd: dir }, { env, home: home(), fetch: fakeJev((i) => (i.includes("payment") ? 0.95 : 0.05)), stateDir });
  assert.ok(first.endsWith(offerInstruction()));
  assert.equal(readOffer(dataDir).lastSession, "q");
  const second = await run({ prompt: "and deploy it", session_id: "q", cwd: dir }, { env, home: home(), fetch: fakeJev((i) => (i.includes("Deploy") ? 0.95 : 0.05)), stateDir });
  assert.match(second, /## deploy/);
  assert.doesNotMatch(second, /AskUserQuestion/);
});

test("typing /jev-rules:pane asks Jev nothing", async () => {
  const calls = [];
  const said = [];
  const deps = { env: { ...TYPESAFE_ENV }, home: home(), fetch: fakeJev(() => 0.9, { calls }), stateDir: temp("jev-rules-state-"), say: (m) => said.push(m) };
  assert.equal(await run({ prompt: "/jev-rules:pane", session_id: "cmd", cwd: project(THREE) }, deps), null);
  assert.deepEqual([calls.length, said], [0, []]);
  assert.match(await run({ prompt: "/jev-rules:pane please and fix checkout", session_id: "cmd2", cwd: project(THREE) }, deps), /## payments/);
});

test("/jev-rules:pane asks exactly the question the hook knows how to answer", () => {
  const command = readFileSync(new URL("../plugins/jev-rules/commands/pane.md", import.meta.url), "utf8");
  assert.ok(command.includes(JSON.stringify({ questions: [QUESTION] })));
  assert.ok(offerInstruction().includes(JSON.stringify({ questions: [QUESTION] })));
  assert.deepEqual(QUESTION.options.map((o) => o.label), Object.values(ANSWERS));
});

// --- the settings file -------------------------------------------------------

test("switching on adds the flag to the env block and keeps everything else", () => {
  const dir = temp("jev-rules-settings-");
  const file = join(dir, "settings.json");
  writeFileSync(file, JSON.stringify({ model: "opus", env: { OTHER: "x" }, permissions: { allow: ["Read"] } }), { mode: 0o640 });
  assert.equal(switchOn(file), "switched-on");
  assert.deepEqual(readJson(file), { model: "opus", env: { OTHER: "x", [FLAG]: "1" }, permissions: { allow: ["Read"] } });
  assert.equal(statSync(file).mode & 0o777, 0o640);
  assert.equal(switchOn(file), "already-on");
});

test("a missing settings file is created, and a broken one is left exactly as it was", () => {
  const dir = temp("jev-rules-settings-");
  const fresh = join(dir, "new", "settings.json");
  assert.equal(switchOn(fresh), "switched-on");
  assert.deepEqual(readJson(fresh), { env: { [FLAG]: "1" } });
  for (const text of ["{ not json", "[1]", JSON.stringify({ env: "x" })]) {
    const file = join(dir, "broken.json");
    writeFileSync(file, text);
    assert.equal(switchOn(file), "unreadable", text);
    assert.equal(readFileSync(file, "utf8"), text);
  }
});

test("a symlinked settings file is written through the link, which stays a link", () => {
  const dir = temp("jev-rules-settings-");
  const real = join(dir, "dotfiles-settings.json");
  writeFileSync(real, "{}");
  const link = join(dir, "settings.json");
  symlinkSync(real, link);
  assert.equal(switchOn(link), "switched-on");
  assert.deepEqual(readJson(real), { env: { [FLAG]: "1" } });
  assert.equal(lstatSync(link).isSymbolicLink(), true);
});

// --- the answer ---------------------------------------------------------------

const answered = (label, question = QUESTION.question) => ({ tool_name: "AskUserQuestion", tool_input: { questions: [], answers: { [question]: label } }, tool_response: { answers: { [question]: label } } });

test("each answer does what its option says", async () => {
  const h = temp("jev-rules-home-");
  const dataDir = temp("jev-rules-data-");
  const env = { CLAUDE_PLUGIN_DATA: dataDir };
  const said = [];
  const say = (m) => said.push(m);

  assert.match(await runAnswer(answered(ANSWERS.later), { env, home: h, say }), /carry on/);
  assert.equal(existsSync(join(h, ".claude")), false);
  assert.equal(readOffer(dataDir).declined, false);

  await runAnswer(answered(ANSWERS.never), { env, home: h, say });
  assert.equal(readOffer(dataDir).declined, true);
  assert.equal(existsSync(join(h, ".claude")), false);

  await runAnswer(answered(ANSWERS.yes), { env, home: h, say });
  assert.deepEqual(readJson(join(h, ".claude", "settings.json")), { env: { [FLAG]: "1" } });
  assert.deepEqual(said, [
    "jev-rules: nothing changed. The pane question comes again in a later session.",
    "jev-rules: the pane question will not come again. /jev-rules:pane asks it at any time.",
    "jev-rules: rules pane switched on in ~/.claude/settings.json. Restart Claude Code to see it, then type /rules.",
  ]);
});

test("CLAUDE_CONFIG_DIR moves the settings file the answer changes", async () => {
  const h = temp("jev-rules-home-");
  const config = join(h, "elsewhere");
  mkdirSync(config);
  await runAnswer(answered(ANSWERS.yes), { env: { CLAUDE_CONFIG_DIR: config }, home: h });
  assert.deepEqual(readJson(join(config, "settings.json")), { env: { [FLAG]: "1" } });
  assert.equal(shortPath(join(config, "settings.json"), h), "~/elsewhere/settings.json");
});

test("other questions, typed answers and other tools are left alone", async () => {
  const h = temp("jev-rules-home-");
  const said = [];
  const deps = { env: {}, home: h, say: (m) => said.push(m) };
  assert.equal(await runAnswer(answered("Yes, turn it on", "Something else?"), deps), null);
  assert.equal(await runAnswer(answered("maybe later, thanks"), deps), null);
  assert.equal(await runAnswer({ tool_name: "Bash", tool_input: {} }, deps), null);
  assert.deepEqual(said, []);
  assert.equal(existsSync(join(h, ".claude")), false);
});

test("an environment value is on when set to anything but 0, false, no or off", () => {
  for (const v of ["1", "true", "yes"]) assert.equal(isOn(v), true, v);
  for (const v of [undefined, "", "0", "false", "NO", "off", " "]) assert.equal(isOn(v), false, String(v));
});
