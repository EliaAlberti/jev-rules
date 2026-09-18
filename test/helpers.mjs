// Shared by the test files: throwaway projects and homes, and a fake Jev.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** Writes one rule into a project as `<name>.md`, replacing any rule of that name. */
export function writeRule(dir, name, { body, ...fields }) {
  const header = Object.entries(fields).filter(([, value]) => value).map(([key, value]) => `${key}: ${value}`);
  const file = join(dir, ".claude", "jev-rules", `${name}.md`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, ["---", ...header, "---", body ?? `${name} body`, ""].join("\n"));
}

/** A project whose rules are `{ name: { body, ...frontmatter } }`; a name may contain `/`. */
export function project(rules) {
  const dir = mkdtempSync(join(tmpdir(), "jev-rules-project-"));
  mkdirSync(join(dir, ".claude", "jev-rules"), { recursive: true });
  for (const [name, fields] of Object.entries(rules)) writeRule(dir, name, fields);
  return dir;
}

export function home() {
  return mkdtempSync(join(tmpdir(), "jev-rules-home-"));
}

export const TYPESAFE_ENV = { JEV_API_KEY: "ts-test-key" };
export const VERCEL_ENV = { AI_GATEWAY_API_KEY: "vck_test" };

/** A fake Jev that scores each question by a function of its instructions text and the request's state. */
export function fakeJev(score, { backend = "typesafe", calls = [] } = {}) {
  return async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, init, body });
    const answers = {};
    for (const [id, q] of Object.entries(body.questions)) {
      const p = score(q.instructions, body.state);
      if (p === null) continue; // simulate a missing answer
      answers[id] = backend === "vercel" ? { type: "boolean", probability: p } : { type: "noul", noul: p };
    }
    const payload = backend === "vercel" ? { answers, usage: {} } : { model: "jev-1.13.0", answers, usage: {} };
    return new Response(JSON.stringify(payload), { status: 200 });
  };
}

export const names = (context) => [...context.matchAll(/^## (.+)$/gm)].map((m) => m[1]);

export const THREE = {
  payments: { description: "Changing payment or checkout code." },
  deploy: { description: "Deploying or releasing." },
  spelling: { description: "Writing prose people read." },
};
