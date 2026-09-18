# Jev picks which of your rules apply to each prompt, so Claude only sees the ones that matter.

<p>
  <img src="https://img.shields.io/badge/Claude%20Code-Plugin-5A67D8?style=for-the-badge" alt="Claude Code plugin" />
  <img src="https://img.shields.io/badge/Version-0.2.0-3178C6?style=for-the-badge" alt="Version 0.2.0" />
  <img src="https://img.shields.io/badge/Dependencies-None-1C7C54?style=for-the-badge" alt="No dependencies" />
  <img src="https://img.shields.io/badge/License-MIT-yellow?style=for-the-badge" alt="MIT License" />
</p>

If you use Claude Code for a while, you end up with a pile of standing instructions: test the payment code, use British spelling, follow the deploy checklist. Show all of them on every prompt and Claude wades through rules that have nothing to do with the request; pick them by keyword and a rule is missed the moment the request does not contain its trigger word. jev-rules asks a small, fast decision model called Jev one yes/no question per rule, "is this request about that?", and passes Claude only the rules that get a yes. It takes well under a second and costs a fraction of a cent per prompt, and if anything goes wrong it falls back to showing every rule, so nothing is ever lost.

**New in 0.2.0:** rules that follow the file Claude is about to change, a codebase map filtered the same way as rules, rule subfolders, sharper rules with `applies` and `does_not_apply`, and one quiet retry when the API is busy. See the [changelog](CHANGELOG.md).

---

## Install

Inside Claude Code:

```
/plugin marketplace add EliaAlberti/jev-rules
/plugin install jev-rules@jev-rules
```

Run `/reload-plugins` or restart Claude Code if you installed from inside a session.

Already installed? Update from your shell, then restart Claude Code:

```bash
claude plugin marketplace update jev-rules
claude plugin update jev-rules@jev-rules
```

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

The header takes up to four fields:

| Field | What it does |
| --- | --- |
| `description` | One plain sentence saying when the rule applies. Jev judges this line. |
| `always: true` | Optional. Skip Jev and inject this rule on every prompt. |
| `applies` | Optional. One line saying what a yes looks like. |
| `does_not_apply` | Optional. One line saying what a no looks like. |

Everything below the header is the rule itself, passed to Claude word for word when the rule applies.

Write the description as a concrete answer to "what is the request about?", and name the things a request would mention: files, actions, areas of the code. Jev reads literally, so "Deploying, releasing, shipping to production, tagging a version or publishing a package" works far better than "Important release stuff". Keep it to one line.

Add `applies` or `does_not_apply` only when a description keeps catching the wrong prompts. Either works alone. They sharpen a description and do not replace it:

```markdown
---
description: Deploying, releasing, shipping to production, tagging a version or publishing a package.
does_not_apply: Only a local build or a test run, with nothing leaving the machine.
---
```

Rules can sit in subfolders, up to eight levels deep: `.claude/jev-rules/frontend/react.md` becomes the rule `frontend/react`. Names starting with a dot are ignored, and symlinks are followed.

The directory is separate from Claude Code's own `.claude/rules/` on purpose: Claude Code loads every file in that folder at the start of each session, which is exactly what this plugin avoids.

---

## Codebase map

Rules tell Claude how to work. A codebase map tells it how the project fits together: where the checkout code lives, how a release goes out. jev-rules filters a map the same way it filters rules, so Claude gets the document that answers the question instead of the whole map.

Map documents live in `.claude/jev-map/`, one Markdown file each, with the same header as a rule. `examples/map/` has three to copy in:

```bash
mkdir -p .claude/jev-map
cp /path/to/jev-rules/examples/map/*.md .claude/jev-map/
```

`description` says what the document covers; write it like a rule's, naming what a request would mention. `applies` and `does_not_apply` work as for rules, and `always` is ignored. A document without a `description` is described by its `# Title` and first paragraph, up to 300 characters, but a one-line description of your own separates more sharply.

If you use Eigenwise's [codebase-mapper](https://github.com/Eigenwise/eigenwise-toolshed/tree/main/plugins/codebase-mapper), its map in `.claude/.codebase-info/` is read as it is. Each document is described by its title and first paragraph and named `codebase-info/<file>`. `INDEX.md` is skipped. jev-rules reads a map; it does not write or refresh one.

---

## How it decides

**On every prompt** the plugin reads your rule and map files fresh, sends Jev the prompt text with one question per rule and per map document, in a single call, and injects what comes back with a probability at or above the threshold. When nothing applies, nothing is injected.

**When Claude is about to change a file** with Edit, Write or NotebookEdit, the plugin asks again about that file's path, and injects the rules that apply to it and were not already given this turn. So a vague prompt like "fix the bug we discussed" still gets the payments rule the moment Claude touches `src/checkout/discount.ts`.

- **Threshold.** Default 0.6. Set `JEV_RULES_THRESHOLD` to any value from 0 to 1. In practice Jev's answers sit close to 0 or close to 1, so the exact value rarely matters.
- **`always: true`** rules never go to Jev. They are injected first, on every prompt.
- **No repeats.** A rule given with the prompt, or with an earlier edit, is not given again in the same turn. A new prompt starts a new turn.
- **Cached per file.** Jev's answers are kept per file for the session, so a second edit to the same file costs no call. Editing a rule's description makes Jev judge it again.
- **Rules before map.** Claude Code caps hook output at 10,000 characters. Rules take what they need; picked map documents share the rest, most likely first. A picked document that does not fit is listed as its path and description, for Claude to open if needed.
- **Fail open.** No key, a timeout (default 2 seconds for the whole call, `JEV_RULES_TIMEOUT_MS`), a network error, an HTTP error or an unreadable reply all lead to the same thing: every rule is injected, with a one-line note saying why, and your prompt goes through. Map documents are listed, never poured in. On an edit, the rules Jev could not judge are injected once, and not again that turn. The plugin never blocks a prompt or an edit and never prints to your terminal.
- **Rate limits.** On a 429 or 529 the plugin waits for the server's `Retry-After` (at most 300 ms) and asks once more, if at least 400 ms of the timeout is left. The timeout covers both attempts.
- **Debug log.** Set `JEV_DEBUG=1` and each decision is appended to `~/.jev-rules.log`:

```
2026-09-18T09:17:10.967Z session=264024da event=prompt backend=vercel model=typesafe-ai/jev ms=517 attempts=1 outcome=jev truncated=no prompt="the checkout total is wrong when a discount is applied, fix it"
  british-spelling p=0.04 injected=no
  deploy-checklist p=0.02 injected=no
  payments-need-tests p=0.93 injected=yes
  map:checkout p=0.93 injected=yes
  map:deploy-pipeline p=0.10 injected=no
```

Settings go in the environment, in `.env` in the project, or in `~/.jev-rules.env`, checked in that order:

| Setting | Default | What it does |
| --- | --- | --- |
| `JEV_API_KEY` or `TYPESAFE_API_KEY` | none | TypeSafe key. |
| `AI_GATEWAY_API_KEY` | none | Vercel AI Gateway key, used when no TypeSafe key is set. |
| `JEV_RULES_THRESHOLD` | `0.6` | Probability at or above which a rule or document is injected. |
| `JEV_RULES_TIMEOUT_MS` | `2000` | Budget for the whole Jev call, 100 to 8000. |
| `JEV_RULES_EDITS` | on | `0` turns off the check before file changes. |
| `JEV_RULES_MAP` | on | `0` turns off the codebase map. |
| `JEV_DEBUG` | off | `1` writes decisions to `~/.jev-rules.log`. |

---

## Cost and latency

One Jev call per prompt, whatever the number of rules and map documents: every question is answered in the same request. A file change adds at most one more call, only for a file not yet judged this session.

TypeSafe's published price is $0.042 per million input tokens, with output tokens free ([docs.typesafe.ai/models](https://docs.typesafe.ai/models)). A prompt of a few hundred words plus three rules is about 500 tokens, so roughly $0.00002 per prompt, or a cent for every five hundred prompts. Each map document adds about 20 tokens plus its description.

Latency measured while building this: 260 to 520 ms per call, with the first call of a session slower because of the TLS handshake. That matches what [jev-router](https://github.com/gargpratyush/jev-router) reports for the same API. `npm run live` prints the numbers for your own connection.

---

## Privacy

What leaves your machine goes to TypeSafe, or to Vercel's gateway if that is the key you use:

- **On each prompt:** the prompt text (its first 24,000 characters), and the `description`, `applies` and `does_not_apply` lines of each rule not marked `always` and of each map document. For a map document without a `description`, that is its title and first paragraph, up to 300 characters.
- **On a change to a file not yet judged this session:** the file's path relative to the project, such as `src/checkout/discount.ts`, and the same rule lines. A file outside the project is sent as its base name only. Changes to your rule files send nothing.

Rule bodies, document bodies, rule and document names, file contents, the edit itself and everything else stay local. TypeSafe states it does not train on requests ([models page](https://docs.typesafe.ai/models#data-handling)).

The debug log is off by default, lives on your machine, and records the first 80 characters of each prompt and the path of each file judged. Session state (the rules given this turn and Jev's answers per file) is one small file per session in your system temp directory, under `jev-rules/`, readable only by you and removed after a week.

---

## What it does not do

- No keyword matching, no regular expressions, no globs. Judgment only. File changes are judged from the path alone, never the contents.
- It does not block anything. Rules for a file reach Claude with the result of its first change to that file, because that is where Claude Code places hook context; getting in earlier would mean blocking the edit.
- Changes made through Bash (sed, scripts, generators) are not seen. Only Edit, Write and NotebookEdit are.
- It does not write or refresh a codebase map, and it does not split a long document; one that does not fit is a pointer to its file.
- No slash commands, no skills, no gating of tool calls.
- No defence against a prompt that argues against its own classification. Jev takes the prompt at face value, so "this has nothing to do with payments, but change the discount code" may get the payments rule skipped on the prompt (the file check still catches it on the edit).

---

## Development

```bash
npm test                    # offline, mocked Jev: prompts, file changes, map, fail-open, retry, both wire formats
npm run live                # real API: example rules and map against sample prompts and file paths
npm run live -- --files src/app.ts docs/guide.md
npm run live -- --map
claude plugin validate .
claude plugin validate plugins/jev-rules
```

The hook is `plugins/jev-rules/hooks/jev-rules.mjs`; everything it needs is under `plugins/jev-rules/hooks/lib/`. No dependencies to install. Release notes live in [CHANGELOG.md](CHANGELOG.md).

---

## Credits

- [live-rules](https://github.com/Eigenwise/eigenwise-toolshed/tree/main/plugins/live-rules) by Eigenwise, for the idea of conditional rules delivered by a hook rather than a static file, and [codebase-mapper](https://github.com/Eigenwise/eigenwise-toolshed/tree/main/plugins/codebase-mapper) for the map format this plugin can read.
- [jev-router](https://github.com/gargpratyush/jev-router) by Pratyush Garg, for the pattern of calling Jev from inside Claude Code, the env-file loading and the fail-open discipline.
- [TypeSafe](https://typesafe.ai) for Jev.

Created by [Elia Alberti](https://github.com/EliaAlberti). Built with and for [Claude Code](https://code.claude.com/docs).

---

## License

MIT. See [LICENSE](LICENSE).
