// The rules pane's logic: the tree, the session record, what flashes, when the
// pane opens by itself, and how a row fits the pane's width.

import test from "node:test";
import assert from "node:assert/strict";
import { fitRow, headline, keyOf, newlyPicked, readRecord, scoreText, shouldAutoOpen, treeRows } from "../plugins/jev-rules/hooks/lib/pane-model.mjs";

const labels = (rows) => rows.map((r) => `${"  ".repeat(r.depth)}${r.label}`);

test("the tree lists rules then map documents, folders before files, by name", () => {
  const rows = treeRows([
    { kind: "rule", name: "payments" },
    { kind: "rule", name: "frontend/react" },
    { kind: "rule", name: "deploy" },
    { kind: "rule", name: "frontend/a11y/forms" },
    { kind: "map", name: "checkout" },
  ]);
  assert.deepEqual(labels(rows), ["rules", "  frontend/", "    a11y/", "      forms", "    react", "  deploy", "  payments", "map", "  checkout"]);
  assert.equal(rows.find((r) => r.label === "react").key, "rule:frontend/react");
  assert.equal(rows.find((r) => r.label === "forms").key, "rule:frontend/a11y/forms");
  assert.equal(rows.find((r) => r.label === "checkout").key, "map:checkout");
});

test("a project with no map documents shows no map heading", () => {
  assert.deepEqual(labels(treeRows([{ kind: "rule", name: "a" }])), ["rules", "  a"]);
});

test("the record marks delivered rules and documents, and this turn's rules, as picked", () => {
  const { picked, scores } = readRecord(JSON.stringify({
    delivered: { "rule:payments": "f1", "map:checkout": "f2" },
    injected: ["tests"],
    scores: { "rule:payments": { p: 0.97, via: "prompt" }, "rule:bad": { p: 7, via: "prompt" } },
  }));
  assert.deepEqual([...picked].sort(), ["map:checkout", "rule:payments", "rule:tests"]);
  assert.deepEqual(scores, { "rule:payments": { p: 0.97, via: "prompt" } });
});

test("a missing or broken record is empty, never an error", () => {
  for (const text of [null, undefined, "", "{", "[]", "42"]) {
    const { picked, scores } = readRecord(text);
    assert.equal(picked.size, 0, String(text));
    assert.deepEqual(scores, {}, String(text));
  }
});

test("only what was not picked before flashes", () => {
  assert.deepEqual(newlyPicked(new Set(["rule:a"]), new Set(["rule:a", "rule:b", "map:c"])), ["rule:b", "map:c"]);
  assert.deepEqual(newlyPicked(new Set(["rule:a"]), new Set()), []);
});

test("the headline counts files only", () => {
  const rows = treeRows([{ kind: "rule", name: "x/a" }, { kind: "rule", name: "b" }, { kind: "map", name: "m" }]);
  assert.equal(headline(rows, new Set([keyOf("rule", "x/a"), keyOf("map", "m")])), "Jev picked 2 of 3");
});

test("scores print with two decimals, and nothing when Jev has not judged the rule", () => {
  assert.equal(scoreText({ p: 0.973, via: "prompt" }), "0.97");
  assert.equal(scoreText({ p: 0, via: "edit" }), "0.00");
  assert.equal(scoreText(undefined), "");
});

test("the pane opens by itself only when allowed, docked, wide enough and not closed by the person", () => {
  const wide = { isFullscreen: true, columns: 180 };
  const base = { setting: "on-first-pick", viewport: wide, closedByPerson: false, isOpen: false };
  assert.equal(shouldAutoOpen(base), true);
  assert.equal(shouldAutoOpen({ ...base, setting: "only-with-command" }), false);
  assert.equal(shouldAutoOpen({ ...base, closedByPerson: true }), false);
  assert.equal(shouldAutoOpen({ ...base, isOpen: true }), false);
  assert.equal(shouldAutoOpen({ ...base, viewport: { isFullscreen: false, columns: 180 } }), false);
  assert.equal(shouldAutoOpen({ ...base, viewport: { isFullscreen: true, columns: 120 } }), false);
  assert.equal(shouldAutoOpen({ ...base, viewport: undefined }), false);
});

test("a row puts the score at the right edge and cuts a name that does not fit", () => {
  const row = fitRow({ depth: 1, label: "payments-need-tests", mark: "✓", score: "0.97", columns: 30 });
  assert.equal(row.length, 30);
  assert.ok(row.startsWith("  ✓ payments-need-tests"));
  assert.ok(row.endsWith("0.97"));
  const cut = fitRow({ depth: 2, label: "a-very-long-rule-name-that-cannot-fit", mark: "·", score: "0.05", columns: 24 });
  assert.equal(cut.length, 24);
  assert.ok(cut.includes("…"));
  assert.equal(fitRow({ depth: 1, label: "deploy", mark: "·", score: "", columns: 30 }), "  · deploy");
});
