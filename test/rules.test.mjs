import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRules, parseFrontmatter } from "../plugins/jev-rules/hooks/lib/rules.mjs";

test("parses a plain description and body", () => {
  const { data, body } = parseFrontmatter("---\ndescription: Deploying or releasing.\n---\nRun the tests first.\n");
  assert.equal(data.description, "Deploying or releasing.");
  assert.equal(body, "Run the tests first.");
});

test("strips single and double quotes and keeps a colon inside the value", () => {
  assert.equal(parseFrontmatter(`---\ndescription: "Deploying: shipping to \\"prod\\""\n---\nx`).data.description, 'Deploying: shipping to "prod"');
  assert.equal(parseFrontmatter("---\ndescription: 'It''s about money: totals'\n---\nx").data.description, "It's about money: totals");
  assert.equal(parseFrontmatter("---\ndescription: Deploying: releasing\n---\nx").data.description, "Deploying: releasing");
});

test("handles CRLF files, comments and blank lines", () => {
  const { data, body } = parseFrontmatter("---\r\n# a comment\r\n\r\ndescription: x\r\nalways: true\r\n---\r\nbody line\r\n");
  assert.equal(data.description, "x");
  assert.equal(data.always, "true");
  assert.equal(body, "body line");
});

test("a file without frontmatter is all body", () => {
  const { data, body } = parseFrontmatter("Just a rule with no header.\n");
  assert.deepEqual(data, {});
  assert.equal(body, "Just a rule with no header.");
});

test("loadRules sorts by name, reads always, and skips empty bodies and non-md files", () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-rules-"));
  mkdirSync(join(dir, "sub"));
  writeFileSync(join(dir, "b.md"), "---\ndescription: B things\n---\nB body");
  writeFileSync(join(dir, "a.md"), "---\nalways: yes\n---\nA body");
  writeFileSync(join(dir, "empty.md"), "---\ndescription: nothing\n---\n\n");
  writeFileSync(join(dir, "notes.txt"), "not a rule");
  writeFileSync(join(dir, "c.md"), "No frontmatter, no description.");
  const rules = loadRules(dir);
  assert.deepEqual(
    rules.map((r) => [r.name, r.description, r.always]),
    [
      ["a", "", true],
      ["b", "B things", false],
      ["c", "", false],
    ],
  );
  assert.equal(rules[1].body, "B body");
});

test("a missing directory is an empty rule set", () => {
  assert.deepEqual(loadRules(join(tmpdir(), "does-not-exist-" + Date.now())), []);
});
