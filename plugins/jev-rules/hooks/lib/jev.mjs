// One Jev call: a small state (the prompt, or the path of a file about to
// change) and one yes/no question per rule.
//
// Two routes reach the same model. TypeSafe's own endpoint is the documented
// default (docs.typesafe.ai/api). Vercel AI Gateway also serves Jev; its wire
// format is the AI SDK evaluation-model dialect, where a Noul is called
// `boolean`. Everything that differs between the two lives in BACKENDS, so the
// rest of the hook does not know which one it is talking to.

import { setTimeout as sleep } from "node:timers/promises";

// The most of a prompt that Jev is sent; the prompt hook cuts it to this.
export const MAX_PROMPT_CHARS = 24000;

// TypeSafe asks clients to retry a 429 (rate limited) or 529 (overloaded)
// after a short delay. A hook cannot wait long, so there is one retry, and
// only when the longest wait plus a reply still fit in the timeout.
const RETRY_STATUSES = [429, 529];
const RETRY_DEFAULT_WAIT_MS = 200;
const RETRY_MAX_WAIT_MS = 300;
const RETRY_MIN_LEFT_MS = 400;

/** The question Jev answers for each rule, given the prompt as `request`. */
export function instructionFor(description) {
  return "The user's `request` is about: " + description;
}

/**
 * The question Jev answers for each rule, given the path of the file about to
 * change as `file`. Jev only ever sees the path, and saying so separated the
 * rules far more cleanly in live runs than the same question without it.
 */
export function fileInstructionFor(description) {
  return "Judging by its path, a change to the file `file` is about: " + description;
}

/** What a yes and a no mean for this rule, from its `applies` and `does_not_apply`; undefined when it has neither. */
export function criteriaFor(rule) {
  const criteria = {};
  if (rule.applies) criteria.true = rule.applies;
  if (rule.does_not_apply) criteria.false = rule.does_not_apply;
  return Object.keys(criteria).length ? criteria : undefined;
}

export const BACKENDS = {
  typesafe: {
    url: "https://api.typesafe.ai/v1/systemone",
    model: "jev-latest",
    headers: (key) => ({ authorization: `Bearer ${key}`, "content-type": "application/json" }),
    encode: (state, questions) => ({
      state,
      model: "jev-latest",
      questions: Object.fromEntries(
        questions.map(({ id, instructions, criteria }) => [id, { type: "noul", instructions, ...(criteria && { criteria }) }]),
      ),
    }),
    decode: (json) => ({
      model: typeof json?.model === "string" ? json.model : "jev-latest",
      probabilities: mapAnswers(json?.answers, (a) => a?.noul),
    }),
  },
  vercel: {
    url: "https://ai-gateway.vercel.sh/v4/ai/evaluation-model",
    model: "typesafe-ai/jev",
    headers: (key) => ({
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      "ai-gateway-protocol-version": "0.0.1",
      "ai-gateway-auth-method": "api-key",
      "ai-evaluation-model-specification-version": "4",
      "ai-model-id": "typesafe-ai/jev",
    }),
    encode: (state, questions) => ({
      state,
      questions: Object.fromEntries(
        questions.map(({ id, instructions, criteria }) => [id, { type: "boolean", instructions, ...(criteria && { criteria }) }]),
      ),
    }),
    decode: (json) => ({
      model: "typesafe-ai/jev",
      probabilities: mapAnswers(json?.answers, (a) => a?.probability),
    }),
  },
};

// Null when the reply has no answers object, so askJev can say how many
// attempts it took before failing.
function mapAnswers(answers, pick) {
  if (!answers || typeof answers !== "object") return null;
  const out = {};
  for (const [id, answer] of Object.entries(answers)) {
    const p = pick(answer);
    if (typeof p === "number" && p >= 0 && p <= 1) out[id] = p;
  }
  return out;
}

function reasoned(reason, message, attempts) {
  return Object.assign(new Error(message), { reason, attempts });
}

/** Retry-After when it is a number of seconds, otherwise a short default, capped either way. */
function retryWait(response) {
  const seconds = Number.parseFloat(response.headers.get("retry-after"));
  const ms = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : RETRY_DEFAULT_WAIT_MS;
  return Math.min(ms, RETRY_MAX_WAIT_MS);
}

/**
 * Asks Jev, in one request, whether each rule applies to `state`.
 *
 * `state` is everything Jev reads besides the questions, such as
 * `{ request: prompt }`, and `instruction(description)` words each question
 * to match it. Rule names never leave the machine: questions are keyed r0,
 * r1, ... and mapped back here. `timeoutMs` is the budget for the whole call.
 * After a 429 or 529 the same request goes once more, after a short wait, if
 * enough of the budget is left. Throws an Error with a `.reason` of
 * `timeout`, `http-<status>`, `network` or `parse`, and the number of
 * `.attempts` made; the caller fails open on any of them.
 *
 * @param {object} options
 * @param {object} options.state
 * @param {(description: string) => string} options.instruction
 * @param {Array<{name: string, description: string, applies?: string, does_not_apply?: string}>} options.rules
 * @returns {Promise<{probabilities: Map<string, number>, model: string, ms: number, attempts: number}>}
 */
export async function askJev({ backend, key, state, instruction, rules, timeoutMs, fetch: fetchImpl = globalThis.fetch }) {
  const wire = BACKENDS[backend];
  if (!wire) throw reasoned("config", `unknown backend ${backend}`, 0);
  const questions = rules.map((rule, i) => ({ id: `r${i}`, instructions: instruction(rule.description), criteria: criteriaFor(rule) }));

  // One deadline covers both attempts and the wait, so a retry can never
  // push the hook past its own time limit.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const request = {
    method: "POST",
    headers: wire.headers(key),
    body: JSON.stringify(wire.encode(state, questions)),
    signal: controller.signal,
  };
  const started = Date.now();
  let attempts = 0;
  const send = async () => {
    attempts += 1;
    const response = await fetchImpl(wire.url, request);
    return { response, text: await response.text() };
  };
  let reply;
  try {
    reply = await send();
    const left = timeoutMs - (Date.now() - started);
    if (RETRY_STATUSES.includes(reply.response.status) && left >= RETRY_MIN_LEFT_MS) {
      await sleep(retryWait(reply.response));
      reply = await send();
    }
  } catch (err) {
    if (controller.signal.aborted || err?.name === "AbortError") throw reasoned("timeout", `no answer within ${timeoutMs} ms`, attempts);
    throw reasoned("network", err?.message ?? String(err), attempts);
  } finally {
    clearTimeout(timer);
  }
  const ms = Date.now() - started;
  const { response, text } = reply;
  if (!response.ok) throw reasoned(`http-${response.status}`, text.slice(0, 200), attempts);

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw reasoned("parse", "response is not JSON", attempts);
  }
  const { model, probabilities } = wire.decode(json);
  if (!probabilities) throw reasoned("parse", "response has no answers", attempts);
  const byName = new Map();
  rules.forEach((rule, i) => {
    if (probabilities[`r${i}`] !== undefined) byName.set(rule.name, probabilities[`r${i}`]);
  });
  return { probabilities: byName, model, ms, attempts };
}
