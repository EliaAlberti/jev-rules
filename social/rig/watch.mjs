#!/usr/bin/env node
// Pretty live view of ~/.jev-rules.log for recordings: one block per decision,
// every rule and map document with its probability, a bar and a tick when it
// was injected. It only reads the real debug log; nothing here is staged.
import { existsSync, readFileSync, statSync, watchFile } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const LOG = join(homedir(), ".jev-rules.log");
const c = (n, s) => `\x1b[${n}m${s}\x1b[0m`;
const bar = (p) => "█".repeat(Math.round(p * 12)).padEnd(12, "░");
let offset = existsSync(LOG) ? statSync(LOG).size : 0;

console.log(c("2", "  waiting for a prompt or a file change...\n"));

let first = true;
function show(chunk) {
  if (first) { process.stdout.write("\x1b[2J\x1b[H"); first = false; }
  for (const line of chunk.split("\n")) {
    if (!line.trim()) continue;
    const head = line.match(/event=(\w+).* ms=(\d+) .*outcome=(\S+).* (prompt|file)="(.*)"$/);
    if (head) {
      const [, event, ms, outcome, , text] = head;
      const label = event === "edit" ? c("1;35", " FILE CHANGE ") : c("1;36", " PROMPT ");
      console.log(`\n${label} ${c("1", text.length > 46 ? text.slice(0, 45) + "…" : text)}`);
      console.log(c("2", `  Jev answered in ${ms} ms${outcome === "jev" ? "" : "  (" + outcome + ")"}\n`));
      continue;
    }
    const row = line.match(/^\s+(map:)?(\S+) (?:p=([\d.]+)|(\S+)) injected=(\w+)/);
    if (!row) continue;
    const [, isMap, name, p, why, injected] = row;
    const on = injected !== "no";
    const score = p ? Number(p) : null;
    const mark = on ? c("1;32", "✓") : c("2", "·");
    const label = (isMap ? "map  " : "rule ") + name;
    const text = `${label.padEnd(31)} ${score === null ? why.padEnd(17) : bar(score) + " " + score.toFixed(2)}`;
    console.log(`  ${mark} ${on ? c("1;32", text) : c("2", text)}`);
  }
}

watchFile(LOG, { interval: 150 }, () => {
  if (!existsSync(LOG)) return;
  const size = statSync(LOG).size;
  if (size < offset) offset = 0;
  if (size === offset) return;
  const chunk = readFileSync(LOG, "utf8").slice(offset);
  offset = size;
  show(chunk);
});
