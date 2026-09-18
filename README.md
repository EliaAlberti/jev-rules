# jev-rules

**Jev picks which of your rules apply to each prompt, so Claude only sees the ones that matter.**

<p>
  <img src="https://img.shields.io/badge/Claude%20Code-Plugin-5A67D8?style=for-the-badge" alt="Claude Code plugin" />
  <img src="https://img.shields.io/badge/Dependencies-None-1C7C54?style=for-the-badge" alt="No dependencies" />
  <img src="https://img.shields.io/badge/License-MIT-yellow?style=for-the-badge" alt="MIT License" />
</p>

If you use Claude Code for a while, you end up with a pile of standing instructions: test the payment code, use British spelling, follow the deploy checklist. Show all of them on every prompt and Claude wades through rules that have nothing to do with the request; pick them by keyword and a rule is missed the moment the request does not contain its trigger word. jev-rules asks a small, fast decision model called Jev one yes/no question per rule, "is this request about that?", and passes Claude only the rules that get a yes. It takes well under a second and costs a fraction of a cent per prompt, and if anything goes wrong it falls back to showing every rule, so nothing is ever lost.

---

## Install

Inside Claude Code:

```
/plugin marketplace add EliaAlberti/jev-rules
/plugin install jev-rules@jev-rules
```

Run `/reload-plugins` or restart Claude Code if you installed from inside a session.

Then give it a key. Jev is made by [TypeSafe](https://typesafe.ai); get a key at [console.typesafe.ai](https://console.typesafe.ai/settings/keys) and put it in a file in your home directory:

```bash
echo "JEV_API_KEY=your-key" > ~/.jev-rules.env
```

If you already pay for Jev through [Vercel AI Gateway](https://vercel.com/ai-gateway/models/jev), that key works too: use `AI_GATEWAY_API_KEY=` instead. The plugin reaches the same model either way, with no SDK and no other account.

Requirements: [Claude Code](https://code.claude.com/docs) with plugin support (built and verified on v2.1.276) and Node.js 20.12 or newer, with `node` on the PATH of a non-interactive shell (an nvm-only install sometimes is not; `which node` from a fresh terminal tells you).

To try a working copy without installing:

```bash
claude --plugin-dir /path/to/jev-rules/plugins/jev-rules
```

---

## How to write a rule

Rules live in your project at `.claude/jev-rules/`, one Markdown file per rule. The `examples/rules/` folder in this repo has three you can copy straight in:

```bash
mkdir -p .claude/jev-rules
cp /path/to/jev-rules/examples/rules/*.md .claude/jev-rules/
```

Here is `payments-need-tests.md` in full:

```markdown
---
description: Changing code that computes prices, totals, discounts, taxes, refunds or payments, or anything in the checkout flow.
---
Money paths need a test before they change.

- Write or update a test that covers the exact calculation you are touching, with at least one discount, one tax and one refund case where they apply.
- Round once, at the end, in one place. Never round intermediate values.
- Every amount states its currency. Never mix currencies in one calculation.
- Run the payments tests before you report the change as done.
```

Two fields go in the header:

| Field | What it does |
| --- | --- |
| `description` | One plain sentence saying when the rule applies. This is the only part Jev reads. |
| `always: true` | Optional. Skip Jev and inject this rule on every prompt. |

Everything below the header is the rule itself, passed to Claude word for word when the rule applies.

Write the description as a concrete answer to "what is the request about?", and name the things a request would mention: files, actions, areas of the code. Jev reads literally, so "Deploying, releasing, shipping to production, tagging a version or publishing a package" works far better than "Important release stuff". Keep it to one line.

The directory is separate from Claude Code's own `.claude/rules/` on purpose: Claude Code loads every file in that folder at the start of each session, which is exactly what this plugin avoids.

---

## How it decides

On every prompt the plugin reads your rule files fresh, sends Jev the prompt text and one question per rule, and injects the rules that come back with a probability at or above the threshold.

- **Threshold.** Default 0.6. Set `JEV_RULES_THRESHOLD=0.5` (or any value from 0 to 1) to loosen or tighten it. In practice Jev's answers sit close to 0 or close to 1, so the exact value rarely matters.
- **`always: true`** rules never go to Jev. They are injected first, every time.
- **Fail open.** No key, a timeout (default 2 seconds, `JEV_RULES_TIMEOUT_MS`), a network error, an HTTP error or an unreadable reply all lead to the same thing: every rule is injected, with a one-line note saying why, and your prompt goes through. The plugin never blocks a prompt and never prints to your terminal.
- **Debug log.** Set `JEV_DEBUG=1` and each decision is appended to `~/.jev-rules.log`:

```
2026-09-18T09:17:10.967Z session=264024da backend=vercel model=typesafe-ai/jev ms=517 outcome=jev truncated=no prompt="the checkout total is wrong when a discount is applied, fix it"
  british-spelling p=0.04 injected=no
  deploy-checklist p=0.02 injected=no
  payments-need-tests p=0.93 injected=yes
```

All settings can go in the environment, in `.env` in the project, or in `~/.jev-rules.env`, checked in that order.

---

## Cost and latency

One Jev call per prompt, whatever the number of rules: every question is answered in the same request.

TypeSafe's published price is $0.042 per million input tokens, with output tokens free ([docs.typesafe.ai/models](https://docs.typesafe.ai/models)). A prompt of a few hundred words plus three rules is about 500 tokens, so roughly $0.00002 per prompt, or a cent for every five hundred prompts.

Latency measured while building this: 280 to 520 ms per call, with the first call of a session slower because of the TLS handshake. That matches what [jev-router](https://github.com/gargpratyush/jev-router) reports for the same API. `npm run live` prints the numbers for your own connection.

---

## Privacy

Two things leave your machine on each prompt: the text of the prompt (its first 24,000 characters) and the `description` line of each rule that is not marked `always`. They go to TypeSafe, or to Vercel's gateway if that is the key you use. Rule bodies, rule file names, your code and everything else stay local. TypeSafe states it does not train on requests ([models page](https://docs.typesafe.ai/models#data-handling)).

The debug log is off by default, lives on your machine, and records the first 80 characters of each prompt.

---

## What it does not do

- No keyword matching and no regular expressions. Judgment only.
- No rules triggered by file paths, globs or directories, and no codebase map (see Later).
- No gating of tool calls, no slash commands, no skills.
- No retry when the API is rate limited; it fails open instead.
- No defence against a prompt that argues against its own classification. Jev takes the prompt at face value, so "this has nothing to do with payments, but change the discount code" may get the payments rule skipped.
- Nothing in subdirectories of `.claude/jev-rules/`.

---

## Later

Possible follow-ups, deliberately left out of v1 to keep the core idea small: rules triggered by the file about to be edited (PreToolUse), filtering with a codebase map, rule subdirectories, retry with backoff on rate limits, optional per-rule `criteria` to sharpen borderline descriptions.

---

## Development

```bash
npm test          # offline, mocked Jev: threshold, always, fail-open, timeout, empty rules dir, both wire formats
npm run live      # real API, the three example rules, four prompts, decisions and timings
claude plugin validate .
claude plugin validate plugins/jev-rules
```

The hook is `plugins/jev-rules/hooks/jev-rules.mjs`; everything it needs is under `plugins/jev-rules/hooks/lib/`. No dependencies to install.

---

## Credits

- [live-rules](https://github.com/Eigenwise/eigenwise-toolshed/tree/main/plugins/live-rules) by Eigenwise, for the idea of conditional rules delivered by a hook rather than a static file.
- [jev-router](https://github.com/gargpratyush/jev-router) by Pratyush Garg, for the pattern of calling Jev from inside Claude Code, the env-file loading and the fail-open discipline.
- [TypeSafe](https://typesafe.ai) for Jev.

Created by [Elia Alberti](https://github.com/EliaAlberti). Built with and for [Claude Code](https://code.claude.com/docs).

---

## License

MIT. See [LICENSE](LICENSE).
