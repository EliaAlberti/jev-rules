import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readConfig } from "../plugins/jev-rules/hooks/lib/config.mjs";
import { runEdit } from "../plugins/jev-rules/hooks/lib/edit.mjs";
import { DESCRIPTION_MAX, deriveDescription, loadMap } from "../plugins/jev-rules/hooks/lib/map.mjs";
import { OUTPUT_BUDGET, run } from "../plugins/jev-rules/hooks/lib/run.mjs";
import { readState } from "../plugins/jev-rules/hooks/lib/state.mjs";
import { fakeJev, home, names, THREE, TYPESAFE_ENV, VERCEL_ENV, writeRule } from "./helpers.mjs";

// --- helpers ---------------------------------------------------------------

/** A project with `files` (`{ "relative/path": text }`) and `rules` as helpers.project takes them. No rules, no rules directory. */
function mapProject(files, rules = {}) {
  const dir = mkdtempSync(join(tmpdir(), "jev-rules-map-"));
  for (const [name, fields] of Object.entries(rules)) writeRule(dir, name, fields);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

/** A `.claude/jev-map` document with a description; the body defaults to the description plus " body". */
const doc = (description, body = `${description} body`) => `---\ndescription: ${description}\n---\n${body}\n`;

/** A fake Jev scorer: each question gets the score of the description it ends with, anything else `rest`. */
const scores = (table, rest = 0.05) => (q) => {
  const hit = Object.keys(table).find((description) => q.endsWith(description));
  return hit === undefined ? rest : table[hit];
};

/** The map section of a prompt's context, or "" when there is none. */
function mapSection(context) {
  const at = context.indexOf("Codebase map documents relevant to this request");
  return at === -1 ? "" : context.slice(at);
}

const pointers = (context) => [...context.matchAll(/^- (\S+): /gm)].map((m) => m[1]);

const RULE_WORDING = "The user's `request` is about: ";
const MAP_WORDING = "Reading a document about the following would help with the user's `request`: ";

/** Two documents, one from each source, the second with no description of its own. */
const TWO = {
  ".claude/jev-map/checkout.md": doc("How checkout computes totals.", "# Checkout\nSECRET_CHECKOUT_BODY"),
  ".claude/.codebase-info/INDEX.md": "# Map\n\nLast Updated: 2026-09-13\n\n- [Architecture](architecture.md)\n",
  ".claude/.codebase-info/architecture.md": "# Architecture\n\nLast Updated: 2026-09-13\n\n## Shape\n\nA plugin marketplace.\n\nSECRET_ARCHITECTURE_BODY\n",
};

const stateDir = () => mkdtempSync(join(tmpdir(), "jev-rules-state-"));

/** A prompt in session s1, with a fresh home and state directory unless `deps` brings its own. */
const prompt = (cwd, deps, text = "x") => run({ prompt: text, cwd, session_id: "s1" }, { home: home(), stateDir: stateDir(), ...deps });

// --- loading ---------------------------------------------------------------

test("both sources are merged and sorted by name, codebase-mapper documents are named codebase-info/..., and INDEX.md is skipped", () => {
  const cwd = mapProject({
    ".claude/jev-map/checkout.md": doc("How checkout works.", "# Checkout\nBody"),
    ".claude/jev-map/ops/deploy.md": doc("Deploying."),
    ".claude/.codebase-info/INDEX.md": "# Map\n\nThe index.\n\n- [Architecture](architecture.md)\n",
    ".claude/.codebase-info/architecture.md": "# Architecture\n\nLast Updated: 2026-09-13\n\nA plugin marketplace.\n",
    ".claude/.codebase-info/sub/INDEX.md": "# Sub index\n\n- [X](x.md)\n",
    ".claude/.codebase-info/sub/x.md": "# X\n\nX things.\n",
    ".claude/.codebase-info/.map-state.json": "{}",
  });
  const docs = loadMap(cwd);
  assert.deepEqual(
    docs.map((d) => [d.name, d.path, d.description]),
    [
      ["checkout", ".claude/jev-map/checkout.md", "How checkout works."],
      ["codebase-info/architecture", ".claude/.codebase-info/architecture.md", "Architecture: A plugin marketplace."],
      ["codebase-info/sub/x", ".claude/.codebase-info/sub/x.md", "X: X things."],
      ["ops/deploy", ".claude/jev-map/ops/deploy.md", "Deploying."],
    ],
  );
  assert.equal(docs[0].body, "# Checkout\nBody");
  assert.equal("always" in docs[0], false);
  assert.deepEqual(loadMap(mkdtempSync(join(tmpdir(), "jev-rules-bare-"))), []);
});

test("a jev-map document without a description is described by its title and first paragraph, and keeps its criteria", () => {
  const cwd = mapProject({
    ".claude/jev-map/plain.md": "# Plain title\n\nSome prose about   plain things.\nContinued here.\n\nSecond paragraph.\n",
    ".claude/jev-map/criteria.md": "---\napplies: A total changes.\n---\n# Totals\n\nHow totals work.\n",
  });
  assert.deepEqual(
    loadMap(cwd).map((d) => [d.name, d.description, d.applies]),
    [
      ["criteria", "Totals: How totals work.", "A total changes."],
      ["plain", "Plain title: Some prose about plain things. Continued here.", undefined],
    ],
  );
});

// --- deriving a description ------------------------------------------------

test("codebase-mapper documents: the title, Last Updated passed over, subheadings passed over, the first paragraph with whitespace collapsed", () => {
  const body = "# Release and publishing\n\nLast Updated: 2026-09-13\n\n## Flow\n\nThe manifests  on `main`\tare delivery.\nExecutors include fragments.\n\nSecond paragraph.";
  assert.equal(deriveDescription(body), "Release and publishing: The manifests on `main` are delivery. Executors include fragments.");
  assert.equal(deriveDescription("# Notes\n\n**Last Updated:** 2026-01-01\nThe first line after it."), "Notes: The first line after it.");
});

test("a list comes down to its first item, marker dropped and continuation kept, numbered or not", () => {
  const bulleted = "# Coding style\n\nLast Updated: 2026-09-09\n\n- Match the surrounding style.\n  Comments explain why.\n- Keep hooks small.\n";
  assert.equal(deriveDescription(bulleted), "Coding style: Match the surrounding style. Comments explain why.");
  assert.equal(deriveDescription("# Onboarding\n\nLast Updated: 2026-09-14\n\n1. Read the README.\n2. Run the tests.\n"), "Onboarding: Read the README.");
  assert.equal(deriveDescription("# Plugins\n\n* **Sidequest** (`plugins/sidequest`): the board.\n\n* Other."), "Plugins: **Sidequest** (`plugins/sidequest`): the board.");
});

test("a description is cut to 300 characters on a word boundary, or mid-word when one word is longer", () => {
  const words = Array.from({ length: 100 }, (_, i) => `word${i}`).join(" ");
  const full = `Title: ${words}`;
  const cut = deriveDescription(`# Title\n\n${words}\n`);
  assert.ok(cut.length <= DESCRIPTION_MAX && cut.length > DESCRIPTION_MAX - 10, `${cut.length} characters`);
  assert.ok(full.startsWith(cut));
  assert.equal(full[cut.length], " ");
  assert.equal(deriveDescription("x".repeat(400)), "x".repeat(DESCRIPTION_MAX));
});

test("no title, fenced code, a title alone, and nothing but code", () => {
  assert.equal(deriveDescription("Just prose, no title.\n\nMore."), "Just prose, no title.");
  assert.equal(deriveDescription("# Tools\n\n```sh\nnpm test\n\nnpm run live\n```\n\nRun the tests first."), "Tools: Run the tests first.");
  assert.equal(deriveDescription("# Only a title\n\nLast Updated: 2026-01-01\n"), "Only a title");
  assert.equal(deriveDescription("```\nconst x = 1;\n```"), "``` const x = 1; ```");
});

// --- one request -----------------------------------------------------------

test("one request asks about rules as r0.. and map documents as m0.., each group in its own wording, and nothing else about a document leaves the machine", async () => {
  const cwd = mapProject(TWO, THREE);
  for (const [backend, env] of [["typesafe", TYPESAFE_ENV], ["vercel", VERCEL_ENV]]) {
    const calls = [];
    await prompt(cwd, { env, fetch: fakeJev(() => 0.9, { backend, calls }) });
    assert.equal(calls.length, 1, backend);
    const { questions } = calls[0].body;
    assert.deepEqual(Object.keys(questions), ["r0", "r1", "r2", "m0", "m1"], backend);
    assert.equal(questions.r0.instructions, RULE_WORDING + "Deploying or releasing.", backend);
    assert.equal(questions.m0.instructions, MAP_WORDING + "How checkout computes totals.", backend);
    assert.equal(questions.m1.instructions, MAP_WORDING + "Architecture: A plugin marketplace.", backend);
    assert.equal(questions.m0.type, backend === "vercel" ? "boolean" : "noul");
    const sent = JSON.stringify(calls[0].body);
    for (const secret of ["SECRET", "checkout.md", "codebase-info", "jev-map", ".claude", cwd]) assert.equal(sent.includes(secret), false, `${backend} ${secret}`);
  }
});

test("applies and does_not_apply reach Jev as criteria for map documents on both backends, and a document without them sends none", async () => {
  const cwd = mapProject({
    ".claude/jev-map/money.md": "---\ndescription: Money.\napplies: An amount is computed.\ndoes_not_apply: Only copy changes.\n---\nbody",
    ".claude/jev-map/words.md": doc("Words."),
  });
  for (const [backend, env] of [["typesafe", TYPESAFE_ENV], ["vercel", VERCEL_ENV]]) {
    const calls = [];
    await prompt(cwd, { env, fetch: fakeJev(() => 1, { backend, calls }) });
    const { questions } = calls[0].body;
    assert.deepEqual(questions.m0.criteria, { true: "An amount is computed.", false: "Only copy changes." }, backend);
    assert.equal("criteria" in questions.m1, false, backend);
  }
});

// --- selection -------------------------------------------------------------

test("a project with map documents and no rules gets the map section alone, and keeps no session state", async () => {
  const cwd = mapProject(TWO);
  const calls = [];
  const state = stateDir();
  const context = await prompt(cwd, { env: TYPESAFE_ENV, stateDir: state, fetch: fakeJev(scores({ "How checkout computes totals.": 0.9 }), { calls }) });
  assert.equal(context, "Codebase map documents relevant to this request (jev-rules, 1 of 2):\n\n## checkout\n# Checkout\nSECRET_CHECKOUT_BODY");
  assert.deepEqual(Object.keys(calls[0].body.questions), ["m0", "m1"]);
  assert.deepEqual(readdirSync(state), []);
});

test("a project with neither rules nor map documents prints nothing and asks nothing, even with an INDEX.md", async () => {
  const cwd = mapProject({ ".claude/jev-map/.draft.md": doc("Hidden."), ".claude/.codebase-info/INDEX.md": "# Map\n\n- [A](a.md)\n" });
  const calls = [];
  assert.equal(await prompt(cwd, { env: TYPESAFE_ENV, fetch: fakeJev(() => 1, { calls }) }), null);
  assert.equal(calls.length, 0);
});

test("documents at or above the threshold go in, most likely first; always means nothing for a document; the rest stay out", async () => {
  const cwd = mapProject(
    {
      ".claude/jev-map/a.md": doc("Doc a."),
      ".claude/jev-map/b.md": doc("Doc b."),
      ".claude/jev-map/c.md": doc("Doc c."),
      ".claude/jev-map/house.md": "---\ndescription: House notes.\nalways: true\n---\nHouse body",
    },
    THREE,
  );
  const calls = [];
  const score = scores({ "Doc a.": 0.61, "Doc b.": 0.95, "Doc c.": 0.6, "House notes.": 0.59, "Changing payment or checkout code.": 0.9 });
  const context = await prompt(cwd, { env: TYPESAFE_ENV, fetch: fakeJev(score, { calls }) });
  assert.deepEqual(names(context), ["payments", "b", "a", "c"]);
  assert.match(mapSection(context), /^Codebase map documents relevant to this request \(jev-rules, 3 of 4\):\n\n## b\nDoc b\. body\n/);
  assert.equal(context.includes("House body"), false);
  assert.equal(Object.keys(calls[0].body.questions).length, 7);

  const strict = await prompt(cwd, { env: { ...TYPESAFE_ENV, JEV_RULES_THRESHOLD: "0.9" }, fetch: fakeJev(score) });
  assert.deepEqual(names(strict), ["payments", "b"]);
  const none = await prompt(cwd, { env: TYPESAFE_ENV, fetch: fakeJev(() => 0.02) });
  // No document helps, so there is no map section at all.
  assert.equal(mapSection(none ?? ""), "");
});

// --- budget ----------------------------------------------------------------

test("rules take the budget first, then map bodies most likely first while they fit, then a pointer for each selected document that did not", async () => {
  const cwd = mapProject(
    {
      ".claude/jev-map/first.md": doc("Doc first.", "f".repeat(2000)),
      ".claude/jev-map/second.md": doc("Doc second.", "s".repeat(2000)),
      ".claude/jev-map/third.md": doc("Doc third.", "t".repeat(300)),
      ".claude/jev-map/unpicked.md": doc("Doc unpicked.", "u".repeat(10)),
    },
    { a: { description: "Rule a.", body: "a".repeat(3000) }, b: { description: "Rule b.", body: "b".repeat(3000) } },
  );
  const score = scores({ "Rule a.": 0.9, "Rule b.": 0.8, "Doc first.": 0.95, "Doc second.": 0.9, "Doc third.": 0.8, "Doc unpicked.": 0.1 });
  const state = stateDir();
  const context = await prompt(cwd, { env: TYPESAFE_ENV, stateDir: state, fetch: fakeJev(score) });
  assert.ok(context.length <= OUTPUT_BUDGET, `${context.length} characters`);
  assert.deepEqual(names(context), ["a", "b", "first", "third"]);
  assert.match(mapSection(context), /^Codebase map documents relevant to this request \(jev-rules, 3 of 4\):\n/);
  assert.match(context, /\n\nToo long to include; read these files if needed:\n- \.claude\/jev-map\/second\.md: Doc second\.$/);
  assert.equal(context.includes("unpicked"), false);
  // Session state lists the rules shown and nothing from the map.
  assert.deepEqual(readState(state, "s1").injected, ["a", "b"]);
});

test("when the rules leave no room for any body, the selected documents are pointers, and when not even every pointer fits the least likely are counted", async () => {
  const files = {};
  const table = { "Rule a.": 0.9 };
  for (let i = 0; i < 10; i++) {
    // Each body alone is bigger than the room the rules leave.
    files[`.claude/jev-map/doc-${i}.md`] = doc(`Doc number ${i}.`, "x".repeat(700));
    table[`Doc number ${i}.`] = 0.99 - i / 100;
  }
  const roomy = mapProject(files, { a: { description: "Rule a.", body: "a".repeat(8300) } });
  const some = await prompt(roomy, { env: TYPESAFE_ENV, fetch: fakeJev(scores(table)) });
  assert.ok(some.length <= OUTPUT_BUDGET, `${some.length} characters`);
  assert.deepEqual(names(some), ["a"]);
  assert.equal(pointers(some).length, 10);

  const tight = mapProject(files, { a: { description: "Rule a.", body: "a".repeat(8600) } });
  const cut = await prompt(tight, { env: TYPESAFE_ENV, fetch: fakeJev(scores(table)) });
  assert.ok(cut.length <= OUTPUT_BUDGET, `${cut.length} characters`);
  const listed = pointers(cut);
  assert.ok(listed.length >= 1 && listed.length < 10, `${listed.length} listed`);
  assert.deepEqual(listed, Array.from({ length: listed.length }, (_, i) => `.claude/jev-map/doc-${i}.md`));
  assert.match(cut, new RegExp(`\\(jev-rules, ${listed.length} of 10\\):`));
  assert.match(cut, new RegExp(`\\n\\n\\(${10 - listed.length} documents omitted: over Claude Code's 10,000-character hook output limit\\)$`));
});

test("rules that fill the whole budget leave no map section at all", async () => {
  const cwd = mapProject(TWO, { house: { always: true, body: "h".repeat(9500) } });
  const context = await prompt(cwd, { env: TYPESAFE_ENV, fetch: fakeJev(() => 0.9) });
  assert.deepEqual(names(context), ["house"]);
  assert.equal(mapSection(context), "");
});

// --- fail open -------------------------------------------------------------

for (const [label, fetchImpl, reason] of [
  ["a network error", async () => { throw new TypeError("fetch failed"); }, "network"],
  ["HTTP 500", async () => new Response("boom", { status: 500 }), "http-500"],
]) {
  test(`on ${label} every rule is injected as before and every map document is listed, never included`, async () => {
    const cwd = mapProject(TWO, THREE);
    const context = await prompt(cwd, { env: TYPESAFE_ENV, fetch: fetchImpl });
    assert.deepEqual(names(context), ["deploy", "payments", "spelling"]);
    assert.equal(
      mapSection(context),
      [
        "Codebase map documents relevant to this request (jev-rules, 2 of 2):",
        `(Jev was unavailable: ${reason}. Documents are listed, not included.)`,
        "",
        "Not judged; read these files if needed:",
        "- .claude/jev-map/checkout.md: How checkout computes totals.",
        "- .claude/.codebase-info/architecture.md: Architecture: A plugin marketplace.",
      ].join("\n"),
    );
    assert.equal(context.includes("SECRET"), false);
  });
}

test("without a key Jev is never called, and a long map is listed within the budget with a count of the rest", async () => {
  const files = {};
  for (let i = 0; i < 60; i++) files[`.claude/jev-map/doc-${String(i).padStart(2, "0")}.md`] = doc(`Doc ${i}: ${"words ".repeat(33)}`, "SECRET_BODY");
  const cwd = mapProject(files, THREE);
  const calls = [];
  const context = await prompt(cwd, { env: {}, fetch: fakeJev(() => 1, { calls }) });
  assert.equal(calls.length, 0);
  assert.ok(context.length <= OUTPUT_BUDGET, `${context.length} characters`);
  assert.deepEqual(names(context), ["deploy", "payments", "spelling"]);
  assert.match(context, /Jev was unavailable: no-key\. Documents are listed, not included\./);
  const listed = pointers(context);
  assert.ok(listed.length > 10 && listed.length < 60, `${listed.length} listed`);
  assert.deepEqual(listed, Array.from({ length: listed.length }, (_, i) => `.claude/jev-map/doc-${String(i).padStart(2, "0")}.md`));
  assert.match(context, new RegExp(`\\n\\n\\(${60 - listed.length} documents omitted: over Claude Code's 10,000-character hook output limit\\)$`));
  assert.equal(context.includes("SECRET_BODY"), false);
});

test("a document Jev gave no answer for is listed, not included, while the others are judged", async () => {
  const cwd = mapProject({ ...TWO, ".claude/jev-map/deploy.md": doc("Deploying.") });
  const score = scores({ "How checkout computes totals.": null, "Deploying.": 0.9 }, 0.1);
  const context = await prompt(cwd, { env: TYPESAFE_ENV, fetch: fakeJev(score) });
  assert.equal(
    context,
    [
      "Codebase map documents relevant to this request (jev-rules, 2 of 3):",
      "",
      "## deploy",
      "Deploying. body",
      "",
      "Not judged; read these files if needed:",
      "- .claude/jev-map/checkout.md: How checkout computes totals.",
    ].join("\n"),
  );
});

// --- switched off, and edits -----------------------------------------------

test("JEV_RULES_MAP=0, false or no turns the map off: no m questions, no map section, and a project with only a map prints nothing", async () => {
  assert.equal(readConfig({}).map, true);
  for (const off of ["0", "false", "No"]) assert.equal(readConfig({ JEV_RULES_MAP: off }).map, false, off);
  assert.equal(readConfig({ JEV_RULES_MAP: "1" }).map, true);

  const calls = [];
  const context = await prompt(mapProject(TWO, THREE), { env: { ...TYPESAFE_ENV, JEV_RULES_MAP: "0" }, fetch: fakeJev(() => 0.9, { calls }) });
  assert.deepEqual(Object.keys(calls[0].body.questions), ["r0", "r1", "r2"]);
  assert.equal(mapSection(context), "");

  // Read through the env files like every other setting.
  const h = home();
  writeFileSync(join(h, ".jev-rules.env"), "JEV_RULES_MAP=no\n");
  const onlyMap = await run({ prompt: "x", cwd: mapProject(TWO) }, { env: TYPESAFE_ENV, home: h, fetch: fakeJev(() => 0.9, { calls }) });
  assert.equal(onlyMap, null);
  assert.equal(calls.length, 1);
});

test("edits never ask about map documents", async () => {
  const edit = (cwd) => ({ hook_event_name: "PreToolUse", session_id: "s1", cwd, tool_name: "Edit", tool_input: { file_path: join(cwd, "src", "checkout.ts") } });
  const deps = () => ({ env: TYPESAFE_ENV, home: home(), stateDir: stateDir() });
  const calls = [];
  const cwd = mapProject(TWO, THREE);
  const text = await runEdit(edit(cwd), { ...deps(), fetch: fakeJev(() => 0.9, { calls }) });
  assert.deepEqual(Object.keys(calls[0].body.questions), ["r0", "r1", "r2"]);
  assert.equal(JSON.stringify(calls[0].body).includes("Reading a document"), false);
  assert.equal(mapSection(text), "");

  assert.equal(await runEdit(edit(mapProject(TWO)), { ...deps(), fetch: fakeJev(() => 0.9, { calls }) }), null);
  assert.equal(calls.length, 1);
});

// --- debug log -------------------------------------------------------------

test("the debug log adds a line per map document after the rules: its body went in, a pointer, or nothing", async () => {
  const cwd = mapProject(
    {
      ".claude/jev-map/first.md": doc("Doc first."),
      ".claude/jev-map/huge.md": doc("Doc huge.", "h".repeat(20000)),
      ".claude/jev-map/no.md": doc("Doc no."),
    },
    THREE,
  );
  const h = home();
  const score = scores({ "Changing payment or checkout code.": 0.9, "Doc first.": 0.95, "Doc huge.": 0.9, "Doc no.": 0.1 });
  await prompt(cwd, { env: { ...TYPESAFE_ENV, JEV_DEBUG: "1" }, home: h, fetch: fakeJev(score) }, "fix the total");
  await prompt(cwd, { env: { JEV_DEBUG: "1" }, home: h, fetch: fakeJev(score) }, "and again");
  const log = readFileSync(join(h, ".jev-rules.log"), "utf8");
  assert.match(
    log,
    new RegExp(
      [
        String.raw`session=s1 event=prompt backend=typesafe model=jev-1\.13\.0 ms=\d+ attempts=1 outcome=jev truncated=no prompt="fix the total"`,
        "  deploy p=0.05 injected=no",
        "  payments p=0.90 injected=yes",
        "  spelling p=0.05 injected=no",
        "  map:first p=0.95 injected=yes",
        "  map:huge p=0.90 injected=pointer",
        "  map:no p=0.10 injected=no",
        "",
      ].join("\n"),
    ),
  );
  assert.match(log, /outcome=fail-open:no-key truncated=no prompt="and again"\n(  \w+ fail-open injected=yes\n){3}(  map:\w+ fail-open injected=pointer\n){3}/);
});
