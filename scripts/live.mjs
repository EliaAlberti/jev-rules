#!/usr/bin/env node
// Hits the real Jev API with the three example rules and prints what the hooks
// would decide, first for a few prompts, then for a few files about to change.
// Needs a key in the environment, ./.env or ~/.jev-rules.env. Costs a fraction
// of a cent.
//
//   npm run live
//   npm run live -- "your own prompt here"
//   npm run live -- --files src/app.ts docs/guide.md

import { homedir } from "node:os";
import { readConfig, resolveEnv } from "../plugins/jev-rules/hooks/lib/config.mjs";
import { decideEdit } from "../plugins/jev-rules/hooks/lib/edit.mjs";
import { decide } from "../plugins/jev-rules/hooks/lib/run.mjs";
import { loadRules } from "../plugins/jev-rules/hooks/lib/rules.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const config = readConfig(resolveEnv(process.env, ROOT, homedir()));
if (!config.key) {
  console.error("No key found. Put JEV_API_KEY=... (TypeSafe) or AI_GATEWAY_API_KEY=... (Vercel AI Gateway) in ~/.jev-rules.env");
  process.exit(1);
}

const rules = loadRules(new URL("../examples/rules", import.meta.url).pathname);
const judged = rules.filter((r) => !r.always && r.description);

let prompts = [
  "the checkout total is wrong when a discount is applied, fix it",
  "tag v1.4.0 and push it to production",
  "rewrite the README introduction so a newcomer understands it",
  "rename the variable tmp to buffer in parser.js",
];
let files = ["src/checkout/discount.ts", ".github/workflows/deploy.yml", "README.md", "src/utils/string-helpers.ts"];
const [first, ...rest] = process.argv.slice(2);
if (first === "--files") {
  prompts = [];
  if (rest.length) files = rest;
} else if (first !== undefined) {
  prompts = [first, ...rest];
  files = [];
}

function show(label, d) {
  console.log(label);
  console.log(`  ${d.outcome}, model ${d.model}, ${d.ms} ms`);
  for (const { rule, p, injected, why } of d.all) {
    const score = p === undefined ? why.padEnd(8) : `p=${p.toFixed(2)}`;
    console.log(`  ${injected ? "inject" : "skip  "}  ${score}  ${rule.name}`);
  }
  console.log();
}

console.log(`backend ${config.backend}, threshold ${config.threshold}, timeout ${config.timeoutMs} ms, ${rules.length} rules\n`);
for (const prompt of prompts) show(`prompt "${prompt}"`, await decide({ rules, prompt, config }));
for (const file of files) show(`edit ${file}`, await decideEdit({ candidates: judged, file, cache: {}, config }));
