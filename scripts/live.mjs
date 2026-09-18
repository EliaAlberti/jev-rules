#!/usr/bin/env node
// Hits the real Jev API with the example rules and map documents and prints
// what the hooks would decide: for a few prompts, the rules and map documents
// together, one request per prompt as the prompt hook sends it, then the
// rules for a few files about to change. `--map` asks about the map documents
// alone, as a project with no rules would. Needs a key in the environment,
// ./.env or ~/.jev-rules.env. Costs a fraction of a cent.
//
//   npm run live
//   npm run live -- "your own prompt here"
//   npm run live -- --files src/app.ts docs/guide.md
//   npm run live -- --map "your own prompt here"

import { homedir } from "node:os";
import { readConfig, resolveEnv } from "../plugins/jev-rules/hooks/lib/config.mjs";
import { decideEdit } from "../plugins/jev-rules/hooks/lib/edit.mjs";
import { loadDocs } from "../plugins/jev-rules/hooks/lib/map.mjs";
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
const docs = loadDocs(ROOT, "examples/map");

let prompts = [
  "the checkout total is wrong when a discount is applied, fix it",
  "tag v1.4.0 and push it to production",
  "rewrite the README introduction so a newcomer understands it",
  "rename the variable tmp to buffer in parser.js",
];
let files = ["src/checkout/discount.ts", ".github/workflows/deploy.yml", "README.md", "src/utils/string-helpers.ts"];
let asked = rules;
const [first, ...rest] = process.argv.slice(2);
if (first === "--files") {
  prompts = [];
  if (rest.length) files = rest;
} else if (first === "--map") {
  asked = [];
  files = [];
  if (rest.length) prompts = rest;
} else if (first !== undefined) {
  prompts = [first, ...rest];
  files = [];
}

function show(label, d) {
  console.log(label);
  console.log(`  ${d.outcome}, model ${d.model}, ${d.ms} ms`);
  const line = (name, { p, injected, why }) => {
    const score = p === undefined ? why.padEnd(8) : `p=${p.toFixed(2)}`;
    console.log(`  ${injected ? "inject" : "skip  "}  ${score}  ${name}`);
  };
  for (const e of d.all) line(e.rule.name, e);
  for (const e of d.map ?? []) line(`map:${e.rule.name}`, e);
  console.log();
}

console.log(`backend ${config.backend}, threshold ${config.threshold}, timeout ${config.timeoutMs} ms, ${asked.length} rules, ${docs.length} map documents\n`);
for (const prompt of prompts) show(`prompt "${prompt}"`, await decide({ rules: asked, docs, prompt, config }));
for (const file of files) show(`edit ${file}`, await decideEdit({ candidates: judged, file, cache: {}, config }));
