import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { readConfig, resolveEnv } from "../plugins/jev-rules/hooks/lib/config.mjs";
import { askJev, BACKENDS, MAX_PROMPT_CHARS } from "../plugins/jev-rules/hooks/lib/jev.mjs";
import { OUTPUT_BUDGET, run } from "../plugins/jev-rules/hooks/lib/run.mjs";

// --- helpers ---------------------------------------------------------------

/** A project whose rules are `{ name: { body, ...frontmatter } }`; a name may contain `/`. */
function project(rules) {
  const dir = mkdtempSync(join(tmpdir(), "jev-rules-project-"));
  const rulesDir = join(dir, ".claude", "jev-rules");
  mkdirSync(rulesDir, { recursive: true });
  for (const [name, { body, ...fields }] of Object.entries(rules)) {
    const header = Object.entries(fields).filter(([, value]) => value).map(([key, value]) => `${key}: ${value}`);
    const file = join(rulesDir, `${name}.md`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, ["---", ...header, "---", body ?? `${name} body`, ""].join("\n"));
  }
  return dir;
}

function home() {
  return mkdtempSync(join(tmpdir(), "jev-rules-home-"));
}

const TYPESAFE_ENV = { JEV_API_KEY: "ts-test-key" };
const VERCEL_ENV = { AI_GATEWAY_API_KEY: "vck_test" };

/** A fake Jev that scores each question by a function of its instructions text. */
function fakeJev(score, { backend = "typesafe", calls = [] } = {}) {
  return async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, init, body });
    const answers = {};
    for (const [id, q] of Object.entries(body.questions)) {
      const p = score(q.instructions);
      if (p === null) continue; // simulate a missing answer
      answers[id] = backend === "vercel" ? { type: "boolean", probability: p } : { type: "noul", noul: p };
    }
    const payload = backend === "vercel" ? { answers, usage: {} } : { model: "jev-1.13.0", answers, usage: {} };
    return new Response(JSON.stringify(payload), { status: 200 });
  };
}

/** A fetch that never answers and gives up only when its request is aborted. */
const hang = (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));

/** A fetch that answers call n with the nth handler (the last one repeats) and records when each call came. */
function inTurn(calls, ...handlers) {
  return async (url, init) => {
    calls.push({ init, at: Date.now() });
    return handlers[Math.min(calls.length, handlers.length) - 1](url, init);
  };
}

/** A fetch handler that answers with an HTTP error. */
const refuse = (status, headers = {}) => async () => new Response("try again later", { status, headers });

/** Delays a fetch handler, to use up part of the budget. */
const after = (ms, handler) => async (url, init) => {
  await sleep(ms);
  return handler(url, init);
};

const names = (context) => [...context.matchAll(/^## (.+)$/gm)].map((m) => m[1]);

const THREE = {
  payments: { description: "Changing payment or checkout code." },
  deploy: { description: "Deploying or releasing." },
  spelling: { description: "Writing prose people read." },
};

// --- threshold -------------------------------------------------------------

test("injects rules at or above the threshold and leaves the rest out", async () => {
  const cwd = project(THREE);
  const score = (q) => (q.includes("payment") ? 0.61 : q.includes("Deploying") ? 0.59 : 0.6);
  const context = await run({ prompt: "fix the checkout total", cwd }, { env: TYPESAFE_ENV, home: home(), fetch: fakeJev(score) });
  assert.deepEqual(names(context), ["payments", "spelling"]);
  assert.match(context, /2 of 3/);
  assert.equal(context.includes("deploy body"), false);
});

test("JEV_RULES_THRESHOLD changes the cut", async () => {
  const cwd = project(THREE);
  const score = (q) => (q.includes("payment") ? 0.61 : 0.3);
  const context = await run({ prompt: "x", cwd }, { env: { ...TYPESAFE_ENV, JEV_RULES_THRESHOLD: "0.25" }, home: home(), fetch: fakeJev(score) });
  assert.deepEqual(names(context), ["payments", "deploy", "spelling"]);
  const strict = await run({ prompt: "x", cwd }, { env: { ...TYPESAFE_ENV, JEV_RULES_THRESHOLD: "0.9" }, home: home(), fetch: fakeJev(score) });
  assert.equal(strict, "Project rules that apply to this request (jev-rules, 0 of 3):");
});

test("selected judged rules are ordered by probability, after fixed rules", async () => {
  const cwd = project({ ...THREE, house: { always: true } });
  const score = (q) => (q.includes("payment") ? 0.7 : q.includes("Deploying") ? 0.95 : 0.8);
  const context = await run({ prompt: "x", cwd }, { env: TYPESAFE_ENV, home: home(), fetch: fakeJev(score) });
  assert.deepEqual(names(context), ["house", "deploy", "spelling", "payments"]);
});

// --- always ----------------------------------------------------------------

test("always rules are injected without being sent to Jev, even when everything scores zero", async () => {
  const cwd = project({ ...THREE, house: { description: "House style.", always: true } });
  const calls = [];
  const context = await run({ prompt: "x", cwd }, { env: TYPESAFE_ENV, home: home(), fetch: fakeJev(() => 0, { calls }) });
  assert.deepEqual(names(context), ["house"]);
  assert.equal(Object.keys(calls[0].body.questions).length, 3);
  assert.equal(JSON.stringify(calls[0].body).includes("House style"), false);
});

test("a rule with no description is always injected, and no Jev call happens when nothing needs judging", async () => {
  const cwd = project({ bare: { description: "" }, house: { always: true } });
  const calls = [];
  const context = await run({ prompt: "x", cwd }, { env: TYPESAFE_ENV, home: home(), fetch: fakeJev(() => 0, { calls }) });
  assert.deepEqual(names(context), ["bare", "house"]);
  assert.equal(calls.length, 0);
});

// --- fail open -------------------------------------------------------------

for (const [label, fetchImpl] of [
  ["a network error", async () => { throw new TypeError("fetch failed"); }],
  ["HTTP 500", async () => new Response("boom", { status: 500 })],
  ["HTTP 429", async () => new Response("slow down", { status: 429 })],
  ["a body that is not JSON", async () => new Response("<html>", { status: 200 })],
  ["a reply without answers", async () => new Response(JSON.stringify({ model: "jev-1.13.0" }), { status: 200 })],
]) {
  test(`fails open on ${label}: every rule is injected and the prompt proceeds`, async () => {
    const cwd = project(THREE);
    const context = await run({ prompt: "x", cwd }, { env: TYPESAFE_ENV, home: home(), fetch: fetchImpl });
    assert.deepEqual(names(context), ["deploy", "payments", "spelling"]);
    assert.match(context, /Jev was unavailable: (network|http-500|http-429|parse)\./);
  });
}

test("fails open on timeout, within the configured deadline", async () => {
  const cwd = project(THREE);
  const started = Date.now();
  const context = await run({ prompt: "x", cwd }, { env: { ...TYPESAFE_ENV, JEV_RULES_TIMEOUT_MS: "100" }, home: home(), fetch: hang });
  assert.ok(Date.now() - started < 1500);
  assert.deepEqual(names(context), ["deploy", "payments", "spelling"]);
  assert.match(context, /Jev was unavailable: timeout\./);
});

test("a rule missing from the answers is injected while the others are judged", async () => {
  const cwd = project(THREE);
  const score = (q) => (q.includes("payment") ? null : q.includes("Deploying") ? 0.1 : 0.9);
  const context = await run({ prompt: "x", cwd }, { env: TYPESAFE_ENV, home: home(), fetch: fakeJev(score) });
  assert.deepEqual(names(context), ["payments", "spelling"]);
});

test("without an API key every rule is injected and fetch is never called", async () => {
  const cwd = project(THREE);
  const calls = [];
  const context = await run({ prompt: "x", cwd }, { env: {}, home: home(), fetch: fakeJev(() => 1, { calls }) });
  assert.deepEqual(names(context), ["deploy", "payments", "spelling"]);
  assert.match(context, /Jev was unavailable: no-key\./);
  assert.equal(calls.length, 0);
});

// --- nothing to do ---------------------------------------------------------

test("an empty rules directory, a missing one, and an empty prompt all produce no output", async () => {
  const empty = project({});
  assert.equal(await run({ prompt: "x", cwd: empty }, { env: TYPESAFE_ENV, home: home(), fetch: fakeJev(() => 1) }), null);
  const bare = mkdtempSync(join(tmpdir(), "jev-rules-bare-"));
  assert.equal(await run({ prompt: "x", cwd: bare }, { env: TYPESAFE_ENV, home: home(), fetch: fakeJev(() => 1) }), null);
  assert.equal(await run({ prompt: "   ", cwd: project(THREE) }, { env: TYPESAFE_ENV, home: home(), fetch: fakeJev(() => 1) }), null);
  assert.equal(await run({}, { env: TYPESAFE_ENV, home: home(), fetch: fakeJev(() => 1) }), null);
});

// --- output cap ------------------------------------------------------------

test("keeps the output under Claude Code's limit by dropping the lowest-probability rules first", async () => {
  const big = "x".repeat(4000);
  const cwd = project({
    house: { always: true, body: "short" },
    a: { description: "A", body: big },
    b: { description: "B", body: big },
    c: { description: "C", body: big },
  });
  const score = (q) => (q.endsWith("A") ? 0.9 : q.endsWith("B") ? 0.7 : 0.8);
  const context = await run({ prompt: "x", cwd }, { env: TYPESAFE_ENV, home: home(), fetch: fakeJev(score) });
  assert.ok(context.length <= OUTPUT_BUDGET);
  assert.deepEqual(names(context), ["house", "a", "c"]);
  assert.match(context, /1 rule omitted/);
});

// --- wire formats ----------------------------------------------------------

test("TypeSafe backend: noul questions, jev-latest, bearer key, prompt as state.request", async () => {
  const cwd = project(THREE);
  const calls = [];
  await run({ prompt: "hello", cwd }, { env: { TYPESAFE_API_KEY: "ts-key" }, home: home(), fetch: fakeJev(() => 1, { calls }) });
  const [{ url, init, body }] = calls;
  assert.equal(url, BACKENDS.typesafe.url);
  assert.equal(init.headers.authorization, "Bearer ts-key");
  assert.equal(body.model, "jev-latest");
  assert.deepEqual(body.state, { request: "hello" });
  assert.deepEqual(Object.keys(body.questions), ["r0", "r1", "r2"]);
  assert.equal(body.questions.r0.type, "noul");
  // Rules are sorted by file name, so r0 is "deploy".
  assert.equal(body.questions.r0.instructions, "The user's `request` is about: Deploying or releasing.");
});

test("Vercel backend: boolean questions, gateway headers, probability answers", async () => {
  const cwd = project(THREE);
  const calls = [];
  const score = (q) => (q.includes("payment") ? 0.9 : 0.1);
  const context = await run({ prompt: "hello", cwd }, { env: VERCEL_ENV, home: home(), fetch: fakeJev(score, { backend: "vercel", calls }) });
  const [{ url, init, body }] = calls;
  assert.equal(url, BACKENDS.vercel.url);
  assert.equal(init.headers.authorization, "Bearer vck_test");
  assert.equal(init.headers["ai-model-id"], "typesafe-ai/jev");
  assert.equal(init.headers["ai-evaluation-model-specification-version"], "4");
  assert.equal(body.model, undefined);
  assert.equal(body.questions.r0.type, "boolean");
  assert.deepEqual(names(context), ["payments"]);
});

test("applies and does_not_apply reach both backends as criteria, and a rule without them sends none", async () => {
  const cwd = project({
    money: { description: "Changing payment code.", applies: "An amount is computed.", does_not_apply: "Only copy changes." },
    ship: { description: "Deploying.", does_not_apply: "Only a local build." },
    words: { description: "Writing prose." },
  });
  for (const [backend, env] of [["typesafe", TYPESAFE_ENV], ["vercel", VERCEL_ENV]]) {
    const calls = [];
    await run({ prompt: "x", cwd }, { env, home: home(), fetch: fakeJev(() => 1, { backend, calls }) });
    const { questions } = calls[0].body;
    assert.deepEqual(questions.r0.criteria, { true: "An amount is computed.", false: "Only copy changes." }, backend);
    assert.deepEqual(questions.r1.criteria, { false: "Only a local build." }, backend);
    assert.equal("criteria" in questions.r2, false, backend);
  }
});

test("a rule in a subdirectory is injected under its path, and the path never reaches Jev", async () => {
  const cwd = project({ "frontend/react": { description: "Changing React components." }, deploy: { description: "Deploying or releasing." } });
  const calls = [];
  const context = await run({ prompt: "x", cwd }, { env: TYPESAFE_ENV, home: home(), fetch: fakeJev(() => 0.9, { calls }) });
  assert.deepEqual(names(context), ["deploy", "frontend/react"]);
  assert.match(context, /^## frontend\/react\nfrontend\/react body$/m);
  assert.equal(JSON.stringify(calls[0].body).includes("frontend"), false);
});

test("a JEV_API_KEY that starts with vck_ is routed to the gateway", () => {
  assert.equal(readConfig({ JEV_API_KEY: "vck_abc" }).backend, "vercel");
  assert.equal(readConfig({ JEV_API_KEY: "ts_abc" }).backend, "typesafe");
  assert.equal(readConfig({ TYPESAFE_API_KEY: "ts_abc", AI_GATEWAY_API_KEY: "vck_abc" }).backend, "typesafe");
  assert.equal(readConfig({}).backend, null);
});

// --- config ----------------------------------------------------------------

test("config defaults, clamps and env-file precedence", () => {
  const c = readConfig({});
  assert.deepEqual([c.threshold, c.timeoutMs, c.debug], [0.6, 2000, false]);
  assert.equal(readConfig({ JEV_RULES_THRESHOLD: "abc" }).threshold, 0.6);
  assert.equal(readConfig({ JEV_RULES_THRESHOLD: "1.5" }).threshold, 1);
  assert.equal(readConfig({ JEV_RULES_TIMEOUT_MS: "99999" }).timeoutMs, 8000);
  assert.equal(readConfig({ JEV_RULES_TIMEOUT_MS: "1" }).timeoutMs, 100);
  assert.equal(readConfig({ JEV_DEBUG: "0" }).debug, false);
  assert.equal(readConfig({ JEV_DEBUG: "1" }).debug, true);

  const dir = project({});
  const h = home();
  writeFileSync(join(dir, ".env"), "JEV_API_KEY=from-project\nJEV_RULES_THRESHOLD=0.7\n");
  writeFileSync(join(h, ".jev-rules.env"), "JEV_API_KEY=from-home\nJEV_DEBUG=1\n");
  const env = resolveEnv({ JEV_API_KEY: "from-shell" }, dir, h);
  assert.equal(env.JEV_API_KEY, "from-shell");
  assert.equal(env.JEV_RULES_THRESHOLD, "0.7");
  assert.equal(env.JEV_DEBUG, "1");
  assert.equal(resolveEnv({}, dir, h).JEV_API_KEY, "from-project");
});

// --- prompt truncation and debug log ---------------------------------------

test("long prompts are cut before they reach Jev, and the debug log records every decision", async () => {
  const cwd = project(THREE);
  const h = home();
  const calls = [];
  const long = "y".repeat(MAX_PROMPT_CHARS + 500);
  const score = (q) => (q.includes("payment") ? 0.9 : 0.2);
  await run({ prompt: long, cwd, session_id: "s1" }, { env: { ...TYPESAFE_ENV, JEV_DEBUG: "1" }, home: h, fetch: fakeJev(score, { calls }) });
  assert.equal(calls[0].body.state.request.length, MAX_PROMPT_CHARS);
  const log = readFileSync(join(h, ".jev-rules.log"), "utf8");
  assert.match(log, /session=s1 backend=typesafe model=jev-1\.13\.0 ms=\d+ attempts=1 outcome=jev truncated=yes prompt="y{80}"/);
  assert.match(log, /^  payments p=0\.90 injected=yes$/m);
  assert.match(log, /^  deploy p=0\.20 injected=no$/m);
});

test("no debug log is written unless JEV_DEBUG is set", async () => {
  const h = home();
  await run({ prompt: "x", cwd: project(THREE) }, { env: TYPESAFE_ENV, home: h, fetch: fakeJev(() => 1) });
  assert.equal(existsSync(join(h, ".jev-rules.log")), false);
});

// --- retry on rate limits --------------------------------------------------

const PAYMENTS = [{ name: "payments", description: "Changing payment or checkout code." }];
const ask = (fetch, timeoutMs = 2000) => askJev({ backend: "typesafe", key: "k", prompt: "x", rules: PAYMENTS, timeoutMs, fetch });

test("a 429 then a 200 succeeds on the second attempt, with the same request after the default 200 ms wait", async () => {
  const calls = [];
  const answer = await ask(inTurn(calls, refuse(429), fakeJev(() => 0.9)));
  assert.equal(answer.attempts, 2);
  assert.equal(answer.probabilities.get("payments"), 0.9);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].init.body, calls[0].init.body);
  assert.ok(calls[1].at - calls[0].at >= 190, `waited ${calls[1].at - calls[0].at} ms`);
});

test("a 529 is retried too, and Retry-After sets the wait up to a 300 ms cap", async () => {
  const calls = [];
  const answer = await ask(inTurn(calls, refuse(529, { "retry-after": "5" }), fakeJev(() => 0.9)));
  assert.equal(answer.attempts, 2);
  const wait = calls[1].at - calls[0].at;
  assert.ok(wait >= 290 && wait < 1000, `waited ${wait} ms`);
});

test("two 429s fail open with http-429, and the debug log counts both attempts", async () => {
  const cwd = project(THREE);
  const h = home();
  const calls = [];
  const fetch = inTurn(calls, refuse(429, { "retry-after": "0" }));
  const context = await run({ prompt: "x", cwd }, { env: { ...TYPESAFE_ENV, JEV_DEBUG: "1" }, home: h, fetch });
  assert.deepEqual(names(context), ["deploy", "payments", "spelling"]);
  assert.match(context, /Jev was unavailable: http-429\./);
  assert.equal(calls.length, 2);
  assert.match(readFileSync(join(h, ".jev-rules.log"), "utf8"), / ms=\d+ attempts=2 outcome=fail-open:http-429 /);
});

test("other HTTP errors and network errors are never retried", async () => {
  for (const [handler, reason] of [
    [refuse(500, { "retry-after": "0" }), "http-500"],
    [async () => { throw new TypeError("fetch failed"); }, "network"],
  ]) {
    const calls = [];
    await assert.rejects(ask(inTurn(calls, handler, fakeJev(() => 0.9))), { reason, attempts: 1 });
    assert.equal(calls.length, 1, reason);
  }
});

test("a 429 is not retried when less than 400 ms of the budget is left", async () => {
  const calls = [];
  const fetch = inTurn(calls, after(150, refuse(429, { "retry-after": "0" })), fakeJev(() => 0.9));
  await assert.rejects(ask(fetch, 500), { reason: "http-429", attempts: 1 });
  assert.equal(calls.length, 1);
});

test("the timeout is the budget for the whole call: a retry that hangs ends at the original deadline", async () => {
  // 150 ms to the 429, then a 300 ms wait. A deadline restarted for the
  // retry would fire at 1100 ms or later instead of 800.
  const calls = [];
  const started = Date.now();
  const fetch = inTurn(calls, after(150, refuse(429, { "retry-after": "5" })), hang);
  await assert.rejects(ask(fetch, 800), { reason: "timeout", attempts: 2 });
  const took = Date.now() - started;
  assert.ok(took >= 790 && took < 1050, `took ${took} ms`);
  assert.equal(calls.length, 2);
});
