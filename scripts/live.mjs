#!/usr/bin/env node
// Hits the real Jev API with the three example rules and a few prompts, and
// prints what the hook would decide. Needs a key in the environment,
// ./.env or ~/.jev-rules.env. Costs a fraction of a cent.
//
//   npm run live
//   npm run live -- "your own prompt here"

import { homedir } from "node:os";
import { readConfig, resolveEnv } from "../plugins/jev-rules/hooks/lib/config.mjs";
import { decide } from "../plugins/jev-rules/hooks/lib/run.mjs";
import { loadRules } from "../plugins/jev-rules/hooks/lib/rules.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const config = readConfig(resolveEnv(process.env, ROOT, homedir()));
if (!config.key) {
  console.error("No key found. Put JEV_API_KEY=... (TypeSafe) or AI_GATEWAY_API_KEY=... (Vercel AI Gateway) in ~/.jev-rules.env");
  process.exit(1);
}

const rules = loadRules(new URL("../examples/rules", import.meta.url).pathname);
const prompts = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [
      "the checkout total is wrong when a discount is applied, fix it",
      "tag v1.4.0 and push it to production",
      "rewrite the README introduction so a newcomer understands it",
      "rename the variable tmp to buffer in parser.js",
    ];

console.log(`backend ${config.backend}, threshold ${config.threshold}, timeout ${config.timeoutMs} ms, ${rules.length} rules\n`);
for (const prompt of prompts) {
  const d = await decide({ rules, prompt, config });
  console.log(`"${prompt}"`);
  console.log(`  ${d.outcome}, model ${d.model}, ${d.ms} ms`);
  for (const { rule, p, injected, why } of d.all) {
    const score = p === undefined ? why.padEnd(8) : `p=${p.toFixed(2)}`;
    console.log(`  ${injected ? "inject" : "skip  "}  ${score}  ${rule.name}`);
  }
  console.log();
}
