import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { cacheKey, jevPath, runEdit } from "../plugins/jev-rules/hooks/lib/edit.mjs";
import { run } from "../plugins/jev-rules/hooks/lib/run.mjs";
import { readState, writeState } from "../plugins/jev-rules/hooks/lib/state.mjs";
import { fakeJev, home, names, project, THREE, TYPESAFE_ENV, VERCEL_ENV, writeRule } from "./helpers.mjs";

// --- helpers ---------------------------------------------------------------

const stateDir = () => mkdtempSync(join(tmpdir(), "jev-rules-state-"));

/** PreToolUse stdin for a change to `path`, which is relative to the project unless absolute. */
function edit(cwd, path, { tool = "Edit" } = {}) {
  const field = tool === "NotebookEdit" ? "notebook_path" : "file_path";
  return {
    hook_event_name: "PreToolUse",
    session_id: "s1",
    cwd,
    tool_name: tool,
    tool_input: { [field]: isAbsolute(path) ? path : join(cwd, path), old_string: "SECRET_OLD_TEXT", new_string: "SECRET_NEW_TEXT" },
  };
}

/** Jev as it should behave: each rule applies to the files in its own area and nowhere else. */
const byFile = (instructions, state) => {
  const file = state.file ?? "";
  if (instructions.includes("payment")) return /checkout|payment/.test(file) ? 0.93 : 0.04;
  if (instructions.includes("Deploying")) return /deploy/.test(file) ? 0.9 : 0.03;
  return /\.md$/.test(file) ? 0.88 : 0.05;
};

const onlyPayments = (q) => (q.includes("payment") ? 0.9 : 0.1);

/** One session: a project, a state directory and the Jev calls its edits made. */
function session({ rules = THREE, env = TYPESAFE_ENV } = {}) {
  const cwd = project(rules);
  const calls = [];
  const deps = { env, home: home(), stateDir: stateDir() };
  return {
    cwd,
    calls,
    deps,
    /** An edit answered by `jev`, a fetch; by default the fake Jev above, recorded in `calls`. */
    edit: (path, { tool, jev } = {}) => runEdit(edit(cwd, path, { tool }), { ...deps, fetch: jev ?? fakeJev(byFile, { calls }) }),
    /** A prompt answered by the fake Jev with `score`; its calls are not recorded. */
    prompt: (text, score) => run({ prompt: text, cwd, session_id: "s1" }, { ...deps, fetch: fakeJev(score) }),
  };
}

const questions = (call) => Object.values(call.body.questions).map((q) => q.instructions);

// --- what gets injected ----------------------------------------------------

test("an edit to a checkout file injects the payments rule only, and Jev sees nothing but the relative path", async () => {
  const s = session();
  const text = await s.edit("src/checkout/discount.ts");
  assert.equal(text, "Project rules that apply to src/checkout/discount.ts (jev-rules, 1 of 3):\n\n## payments\npayments body");
  const [{ body }] = s.calls;
  assert.deepEqual(body.state, { file: "src/checkout/discount.ts" });
  assert.deepEqual(Object.keys(body.questions), ["r0", "r1", "r2"]);
  // Rules are sorted by name, so r1 is payments.
  assert.equal(body.questions.r1.instructions, "Judging by its path, a change to the file `file` is about: Changing payment or checkout code.");
  const sent = JSON.stringify(body);
  for (const secret of ["SECRET", s.cwd, "payments"]) assert.equal(sent.includes(secret), false, secret);
});

test("the Vercel route gets the same file state", async () => {
  const s = session({ env: VERCEL_ENV });
  const calls = [];
  const text = await s.edit("src/checkout/discount.ts", { jev: fakeJev(byFile, { backend: "vercel", calls }) });
  assert.deepEqual(names(text), ["payments"]);
  assert.deepEqual(calls[0].body.state, { file: "src/checkout/discount.ts" });
  assert.equal(calls[0].body.questions.r1.type, "boolean");
});

test("rules the prompt gave this turn, and always rules, are neither repeated nor sent to Jev", async () => {
  const s = session({ rules: { ...THREE, house: { always: true } } });
  assert.deepEqual(names(await s.prompt("fix the discount at checkout", onlyPayments)), ["house", "payments"]);
  assert.equal(await s.edit("src/checkout/discount.ts"), null);
  assert.deepEqual(questions(s.calls[0]), [
    "Judging by its path, a change to the file `file` is about: Deploying or releasing.",
    "Judging by its path, a change to the file `file` is about: Writing prose people read.",
  ]);
});

test("a rule the prompt had to leave out for size is still offered on an edit", async () => {
  const big = "x".repeat(4000);
  const s = session({ rules: { a: { description: "A", body: big }, b: { description: "B", body: big }, c: { description: "C", body: big } } });
  const shown = await s.prompt("x", (q) => (q.endsWith("A") ? 0.9 : q.endsWith("B") ? 0.7 : 0.8));
  assert.deepEqual(names(shown), ["a", "c"]);
  const text = await s.edit("src/b.ts", { jev: fakeJev((q) => (q.endsWith("B") ? 0.9 : 0.1), { calls: s.calls }) });
  assert.deepEqual(names(text), ["b"]);
  assert.deepEqual(questions(s.calls[0]), ["Judging by its path, a change to the file `file` is about: B"]);
});

test("NotebookEdit is judged by its notebook_path", async () => {
  const s = session();
  const text = await s.edit("analysis/checkout-funnel.ipynb", { tool: "NotebookEdit" });
  assert.deepEqual(names(text), ["payments"]);
  assert.deepEqual(s.calls[0].body.state, { file: "analysis/checkout-funnel.ipynb" });
});

// --- cache and turns -------------------------------------------------------

test("a second edit to the same file makes no Jev call", async () => {
  const s = session();
  assert.deepEqual(names(await s.edit("src/checkout/discount.ts")), ["payments"]);
  assert.equal(await s.edit("src/checkout/discount.ts"), null);
  assert.equal(await s.edit("src/checkout/discount.ts", { tool: "Write" }), null);
  assert.equal(s.calls.length, 1);
});

test("with JEV_RULES_REPEAT=1 a new prompt starts a new turn: a rule can come back, answered from the cache", async () => {
  const s = session({ env: { ...TYPESAFE_ENV, JEV_RULES_REPEAT: "1" } });
  assert.deepEqual(names(await s.edit("src/checkout/discount.ts")), ["payments"]);
  assert.equal(await s.edit("src/checkout/discount.ts"), null);
  await s.prompt("now tidy the logging", () => 0.1);
  assert.deepEqual(readState(s.deps.stateDir, "s1").injected, []);
  assert.deepEqual(names(await s.edit("src/checkout/discount.ts")), ["payments"]);
  assert.equal(s.calls.length, 1);
});

test("changing a rule's description asks Jev about that rule again, and only that rule", async () => {
  const s = session();
  await s.edit("src/checkout/discount.ts");
  writeRule(s.cwd, "deploy", { description: "Deploying, or changing how checkout ships." });
  const text = await s.edit("src/checkout/discount.ts", { jev: fakeJev((q) => (q.includes("checkout") ? 0.9 : 0.1), { calls: s.calls }) });
  assert.deepEqual(names(text), ["deploy"]);
  assert.equal(s.calls.length, 2);
  assert.deepEqual(questions(s.calls[1]), ["Judging by its path, a change to the file `file` is about: Deploying, or changing how checkout ships."]);
});

test("the cache key follows what Jev reads about a rule, and nothing else", () => {
  const rule = { name: "a", description: "D", body: "B" };
  const key = cacheKey(rule);
  assert.match(key, /^[0-9a-f]{12}$/);
  assert.equal(cacheKey({ ...rule, name: "b", body: "other" }), key);
  for (const change of [{ description: "E" }, { applies: "when yes" }, { does_not_apply: "when no" }]) {
    assert.notEqual(cacheKey({ ...rule, ...change }), key, JSON.stringify(change));
  }
});

// --- fail open -------------------------------------------------------------

test("with JEV_RULES_REPEAT=1, when Jev fails the remaining rules are injected once for the turn, and the failure is not cached", async () => {
  const s = session({ env: { ...TYPESAFE_ENV, JEV_RULES_REPEAT: "1" } });
  let failures = 0;
  const down = async () => {
    failures += 1;
    return new Response("boom", { status: 500 });
  };
  const text = await s.edit("src/utils/string-helpers.ts", { jev: down });
  assert.deepEqual(names(text), ["deploy", "payments", "spelling"]);
  assert.match(text, /^\(Jev was unavailable: http-500\. Every rule it could not judge is included\.\)$/m);
  assert.equal(await s.edit("src/utils/string-helpers.ts", { jev: down }), null);
  assert.equal(await s.edit("docs/guide.md", { jev: down }), null);
  assert.equal(failures, 1);

  await s.prompt("carry on", () => 0.1);
  assert.equal(await s.edit("src/utils/string-helpers.ts"), null);
  assert.equal(questions(s.calls[0]).length, 3);
});

test("without a key: after a prompt an edit adds nothing, before one it injects the rules once, and Jev is never called", async () => {
  const after = session({ env: {} });
  assert.deepEqual(names(await after.prompt("fix the checkout", () => 1)), ["deploy", "payments", "spelling"]);
  assert.equal(await after.edit("src/checkout/discount.ts"), null);

  const before = session({ env: {} });
  const text = await before.edit("src/checkout/discount.ts");
  assert.deepEqual(names(text), ["deploy", "payments", "spelling"]);
  assert.match(text, /Jev was unavailable: no-key\./);
  assert.equal(await before.edit("src/other.ts"), null);
  assert.equal(after.calls.length + before.calls.length, 0);
});

// --- which files -----------------------------------------------------------

test("a file outside the project reaches Jev as its base name only", async () => {
  const s = session();
  const text = await s.edit(join(tmpdir(), "jev-rules-elsewhere", "private", "plan.md"));
  assert.deepEqual(names(text), ["spelling"]);
  assert.match(text, /^Project rules that apply to plan\.md \(/);
  assert.deepEqual(s.calls[0].body.state, { file: "plan.md" });
  assert.equal(JSON.stringify(s.calls[0].body).includes("elsewhere"), false);
});

test("jevPath: relative inside the project, the base name outside it, whatever the spelling", () => {
  const root = join(tmpdir(), "proj");
  assert.equal(jevPath(join(root, "src", "a.ts"), root), "src/a.ts");
  assert.equal(jevPath(join("src", "a.ts"), root), "src/a.ts");
  assert.equal(jevPath(join(root, "..notes.md"), root), "..notes.md");
  assert.equal(jevPath(`${root}-other/secret/a.ts`, root), "a.ts");
  assert.equal(jevPath(join(root, "src", "..", "..", "elsewhere", "b.md"), root), "b.md");
  assert.equal(jevPath(root, root), "proj");
});

test("editing a rule file asks Jev nothing, since its path is the rule's name", async () => {
  const s = session();
  assert.equal(await s.edit(".claude/jev-rules/payments.md"), null);
  assert.equal(s.calls.length, 0);
});

test("another tool, or an edit without a path, prints nothing and asks nothing", async () => {
  const s = session();
  const deps = { ...s.deps, fetch: fakeJev(() => 1, { calls: s.calls }) };
  const base = edit(s.cwd, "src/checkout/discount.ts");
  for (const input of [
    { ...base, tool_name: "Bash", tool_input: { command: "rm -rf src" } },
    { ...base, tool_name: "Read" },
    { ...base, tool_input: {} },
    { ...base, tool_input: null },
    { ...base, tool_input: { file_path: 42 } },
    { ...base, tool_name: "NotebookEdit" },
    {},
    null,
  ]) {
    assert.equal(await runEdit(input, deps), null, JSON.stringify(input));
  }
  assert.equal(s.calls.length, 0);
  assert.deepEqual(readdirSync(s.deps.stateDir), []);
});

test("JEV_RULES_EDITS=0 turns the edit hook off, and in repeat mode the prompt hook then keeps no state", async () => {
  const s = session({ env: { ...TYPESAFE_ENV, JEV_RULES_EDITS: "0", JEV_RULES_REPEAT: "1" } });
  assert.deepEqual(names(await s.prompt("fix the checkout", onlyPayments)), ["payments"]);
  assert.equal(await s.edit("src/checkout/discount.ts"), null);
  assert.equal(s.calls.length, 0);
  assert.deepEqual(readdirSync(s.deps.stateDir), []);
});

// --- state file ------------------------------------------------------------

test("a corrupt or malformed state file reads as empty, and the next write repairs it", async () => {
  for (const junk of ["{not json", "null", "[]", '"text"', '{"injected":"payments","files":[]}']) {
    const s = session();
    writeFileSync(join(s.deps.stateDir, "s1.json"), junk);
    assert.deepEqual(names(await s.edit("src/checkout/discount.ts")), ["payments"], junk);
    assert.deepEqual(readState(s.deps.stateDir, "s1").injected, ["payments"], junk);
  }
});

test("reading keeps only well-formed entries, and a file called __proto__ is cached like any other", async () => {
  const dir = stateDir();
  writeFileSync(join(dir, "s1.json"), '{"injected":[1,"payments"],"files":{"a.ts":{"k1":0.5,"k2":"0.9","k3":7},"b.ts":"nope","__proto__":{"k4":0.2}}}');
  const state = readState(dir, "s1");
  assert.deepEqual(state.injected, ["payments"]);
  assert.deepEqual(Object.keys(state.files), ["a.ts", "__proto__"]);
  assert.deepEqual(state.files["a.ts"], { k1: 0.5 });

  const s = session();
  assert.equal(await s.edit("__proto__"), null);
  assert.equal(await s.edit("__proto__"), null);
  assert.equal(s.calls.length, 1);
  for (const rule of Object.values(THREE)) assert.equal({}[cacheKey(rule)], undefined);
});

test("state is written whole with no temporary file left, and files untouched for a week are swept", () => {
  const dir = stateDir();
  const daysAgo = (n) => (Date.now() - n * 24 * 60 * 60 * 1000) / 1000;
  writeFileSync(join(dir, "old.json"), "{}");
  writeFileSync(join(dir, "recent.json"), "{}");
  utimesSync(join(dir, "old.json"), daysAgo(8), daysAgo(8));
  utimesSync(join(dir, "recent.json"), daysAgo(6), daysAgo(6));
  writeState(dir, "s1", { injected: ["payments"], files: { "a.ts": { k: 0.5 } } });
  assert.deepEqual(readdirSync(dir).sort(), ["recent.json", "s1.json"]);
  assert.deepEqual(readState(dir, "s1"), { injected: ["payments"], files: { "a.ts": { k: 0.5 } }, delivered: {}, scores: {} });
});

test("a session id that is not a plain name gets no state file", () => {
  const dir = stateDir();
  for (const id of ["../escape", "a/b", "", undefined, 42]) {
    writeState(dir, id, { injected: ["x"], files: {} });
    assert.deepEqual(readState(dir, id), { injected: [], files: {}, delivered: {}, scores: {} }, String(id));
  }
  assert.deepEqual(readdirSync(dir), []);
  assert.equal(existsSync(join(dir, "..", "escape.json")), false);
});

// --- debug log -------------------------------------------------------------

test("the debug log records each edit with the file and how many answers came from the cache", async () => {
  const s = session({ env: { ...TYPESAFE_ENV, JEV_DEBUG: "1", JEV_RULES_REPEAT: "1" } });
  await s.edit("src/checkout/discount.ts");
  await s.prompt("next", () => 0.1);
  await s.edit("src/checkout/discount.ts");
  const log = readFileSync(join(s.deps.home, ".jev-rules.log"), "utf8");
  assert.match(
    log,
    /session=s1 event=edit backend=typesafe model=jev-1\.13\.0 ms=\d+ attempts=1 outcome=jev truncated=no cached=0 file="src\/checkout\/discount\.ts"\n  deploy p=0\.03 injected=no\n  payments p=0\.93 injected=yes\n  spelling p=0\.05 injected=no\n/,
  );
  assert.match(log, /session=s1 event=prompt backend=typesafe /);
  assert.match(log, /session=s1 event=edit backend=typesafe model=none ms=0 attempts=0 outcome=no-jev-needed truncated=no cached=3 file="src\/checkout\/discount\.ts"\n/);
});
