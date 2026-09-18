import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadRules, parseFrontmatter } from "../plugins/jev-rules/hooks/lib/rules.mjs";

/** Writes `{ "relative/path.md": text }` into a fresh directory. */
function tree(files) {
  const dir = mkdtempSync(join(tmpdir(), "jev-rules-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

const names = (dir) => loadRules(dir).map((r) => r.name);

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

test("parses applies and does_not_apply like any other field", () => {
  const { data } = parseFrontmatter("---\ndescription: Money.\napplies: A total is computed.\ndoes_not_apply: 'Only the label changes: nothing else'\n---\nx");
  assert.equal(data.applies, "A total is computed.");
  assert.equal(data.does_not_apply, "Only the label changes: nothing else");
});

test("loadRules exposes applies and does_not_apply trimmed, or undefined when missing or blank", () => {
  const dir = tree({
    "money.md": '---\ndescription: Money.\napplies: "  A total is computed.  "\ndoes_not_apply: Only the label changes.\n---\nbody',
    "blank.md": "---\ndescription: Blank.\napplies:\ndoes_not_apply: '   '\n---\nbody",
    "plain.md": "---\ndescription: Plain.\n---\nbody",
  });
  assert.deepEqual(
    loadRules(dir).map((r) => [r.name, r.applies, r.does_not_apply]),
    [
      ["blank", undefined, undefined],
      ["money", "A total is computed.", "Only the label changes."],
      ["plain", undefined, undefined],
    ],
  );
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

// --- subdirectories --------------------------------------------------------

test("rules in subdirectories are named by their path and the whole list is sorted by name", () => {
  const dir = tree({
    "b.md": "---\ndescription: B things\n---\nB body",
    "c/z.md": "Z body",
    "c/deep/y.md": "Y body",
    "a/x.md": "---\ndescription: X things\n---\nX body",
    "frontend/react.md": "React body",
    "frontend.md": "Frontend body",
  });
  const rules = loadRules(dir);
  // A walk that sorted each directory on its own would put frontend/react before frontend.
  assert.deepEqual(rules.map((r) => r.name), ["a/x", "b", "c/deep/y", "c/z", "frontend", "frontend/react"]);
  assert.deepEqual([rules[0].description, rules[0].body], ["X things", "X body"]);
});

test("dot-directories and dot-files are ignored at any depth", () => {
  const dir = tree({
    "a.md": "A",
    ".hidden.md": "hidden",
    ".drafts/d.md": "draft",
    "sub/s.md": "S",
    "sub/.cache/c.md": "cached",
  });
  assert.deepEqual(names(dir), ["a", "sub/s"]);
});

test("symlinks are followed, a directory reachable twice is read once, and a symlink cycle terminates", () => {
  const outside = tree({ "shared/s.md": "S", "one.md": "One" });
  const dir = tree({ "a.md": "A", "sub/b.md": "B" });
  symlinkSync(join(outside, "shared"), join(dir, "shared"));
  symlinkSync(join(outside, "one.md"), join(dir, "linked.md"));
  symlinkSync(join(outside, "gone"), join(dir, "dangling.md"));
  symlinkSync(join(dir, "sub"), join(dir, "sub-again"));
  symlinkSync(dir, join(dir, "sub", "up")); // back to the rules directory
  symlinkSync(join(dir, "sub"), join(dir, "sub", "self"));
  assert.deepEqual(names(dir), ["a", "linked", "shared/s", "sub/b"]);
});

test("rules are read up to eight directories deep and no deeper", () => {
  const eight = "1/2/3/4/5/6/7/8";
  const dir = tree({ [`${eight}/ok.md`]: "OK", [`${eight}/9/too-deep.md`]: "too deep" });
  assert.deepEqual(names(dir), [`${eight}/ok`]);
});
