// One Jev call: the prompt as state, one yes/no question per rule.
//
// Two routes reach the same model. TypeSafe's own endpoint is the documented
// default (docs.typesafe.ai/api). Vercel AI Gateway also serves Jev; its wire
// format is the AI SDK evaluation-model dialect, where a Noul is called
// `boolean`. Everything that differs between the two lives in BACKENDS, so the
// rest of the hook does not know which one it is talking to.

export const MAX_PROMPT_CHARS = 24000;

/** The question Jev answers for each rule. */
export function instructionFor(description) {
  return "The user's `request` is about: " + description;
}

export const BACKENDS = {
  typesafe: {
    url: "https://api.typesafe.ai/v1/systemone",
    model: "jev-latest",
    headers: (key) => ({ authorization: `Bearer ${key}`, "content-type": "application/json" }),
    encode: (state, questions) => ({
      state,
      model: "jev-latest",
      questions: Object.fromEntries(questions.map(({ id, instructions }) => [id, { type: "noul", instructions }])),
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
      questions: Object.fromEntries(questions.map(({ id, instructions }) => [id, { type: "boolean", instructions }])),
    }),
    decode: (json) => ({
      model: "typesafe-ai/jev",
      probabilities: mapAnswers(json?.answers, (a) => a?.probability),
    }),
  },
};

function mapAnswers(answers, pick) {
  if (!answers || typeof answers !== "object") throw reasoned("parse", "response has no answers");
  const out = {};
  for (const [id, answer] of Object.entries(answers)) {
    const p = pick(answer);
    if (typeof p === "number" && p >= 0 && p <= 1) out[id] = p;
  }
  return out;
}

function reasoned(reason, message) {
  const err = new Error(message);
  err.reason = reason;
  return err;
}

/**
 * Asks Jev, once, whether each rule applies to the prompt.
 *
 * Rule names never leave the machine: questions are keyed r0, r1, ... and
 * mapped back here. Throws an Error with a `.reason` of `timeout`,
 * `http-<status>`, `network` or `parse`; the caller fails open on any of them.
 *
 * @returns {Promise<{probabilities: Map<string, number>, model: string, ms: number, truncated: boolean}>}
 */
export async function askJev({ backend, key, prompt, rules, timeoutMs, fetch: fetchImpl = globalThis.fetch }) {
  const wire = BACKENDS[backend];
  if (!wire) throw reasoned("config", `unknown backend ${backend}`);
  const truncated = prompt.length > MAX_PROMPT_CHARS;
  const state = { request: truncated ? prompt.slice(0, MAX_PROMPT_CHARS) : prompt };
  const questions = rules.map((rule, i) => ({ id: `r${i}`, instructions: instructionFor(rule.description) }));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  let response;
  let text;
  try {
    response = await fetchImpl(wire.url, {
      method: "POST",
      headers: wire.headers(key),
      body: JSON.stringify(wire.encode(state, questions)),
      signal: controller.signal,
    });
    text = await response.text();
  } catch (err) {
    if (controller.signal.aborted || err?.name === "AbortError") throw reasoned("timeout", `no answer within ${timeoutMs} ms`);
    throw reasoned("network", err?.message ?? String(err));
  } finally {
    clearTimeout(timer);
  }
  const ms = Date.now() - started;
  if (!response.ok) throw reasoned(`http-${response.status}`, text.slice(0, 200));

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw reasoned("parse", "response is not JSON");
  }
  const { model, probabilities } = wire.decode(json);
  const byName = new Map();
  rules.forEach((rule, i) => {
    if (probabilities[`r${i}`] !== undefined) byName.set(rule.name, probabilities[`r${i}`]);
  });
  return { probabilities: byName, model, ms, truncated };
}
