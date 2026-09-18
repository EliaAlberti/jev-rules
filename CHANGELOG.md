# Changelog

All notable changes to jev-rules. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [0.3.0] - 2026-09-18

### Changed

- **Once-per-session delivery is the default.** A rule or map document Claude has already been given is not delivered again in that session, by a prompt or by an edit, and Jev is no longer asked about it. 0.2.0 delivered on every matching prompt, and those tokens accumulated: on the demo project an 8-prompt checkout session injected about 2,510 tokens; it now injects about 330, against about 1,390 for loading all rules and documents up front. `always: true` rules are also delivered once per session.
- Editing a rule's text makes it deliverable again. After `/clear` or a compaction everything is deliverable again, through a new SessionStart hook that only runs for those two events.
- A fail-open now costs one full delivery per session instead of one per prompt.
- The prompt hook keeps its small session state file even when `JEV_RULES_EDITS=0`.

### Added

- `JEV_RULES_REPEAT=1` restores delivery on every matching prompt.
- Debug log: `delivered-earlier injected=seen` lines, and `outcome=nothing-new` when a prompt has nothing left to deliver.
- 13 new offline tests (101 in total).

### Upgrade

```bash
claude plugin marketplace update jev-rules
claude plugin update jev-rules@jev-rules
```

Restart Claude Code afterwards so the new SessionStart hook is registered.

## [0.2.0] - 2026-09-18

Everything that 0.1.0 listed under "Later" is now built.

### Added

- **File-triggered rules.** Before Claude changes a file with Edit, Write, MultiEdit or NotebookEdit, Jev judges the file's path against the rules not yet given this turn, and the ones that apply are injected. Only the project-relative path leaves the machine. Answers are cached per file for the session, a rule is never repeated within a turn, and `JEV_RULES_EDITS=0` turns the check off.
- **Codebase map filtering.** Documents in `.claude/jev-map/`, and Eigenwise codebase-mapper's `.claude/.codebase-info/` when present, are judged in the same single call as the rules. Rules take the output budget first; a picked document that does not fit becomes a pointer to its file. `JEV_RULES_MAP=0` turns it off. Three example documents ship in `examples/map/`.
- **Rule subfolders.** `.claude/jev-rules/frontend/react.md` becomes the rule `frontend/react`, up to eight levels deep. Symlinks are followed and loops end safely.
- **Per-rule criteria.** Optional `applies` and `does_not_apply` lines say what a yes and a no look like, for descriptions that keep catching the wrong prompts.
- **One retry on rate limits.** A 429 or 529 is retried once, honouring `Retry-After` up to 300 ms, inside the same overall timeout.
- `npm run live` now also checks file paths (`--files`) and the map (`--map`).

### Changed

- When nothing applies, nothing is injected. 0.1.0 injected an empty "0 of N" heading on every such prompt.
- `JEV_RULES_TIMEOUT_MS` is now the budget for the whole call, retry included.
- Debug log lines gained `event=prompt|edit` and `attempts=<n>`; edits log `file="..."` and `cached=<n>`; map documents log as `map:<name>`. Anything parsing the 0.1.0 format needs updating.
- Dot-files in the rules folder (such as `.draft.md`) are no longer loaded, and symlinked rule files now are.
- Test suite grew from 30 to 88 offline tests.

### Upgrade

```bash
claude plugin marketplace update jev-rules
claude plugin update jev-rules@jev-rules
```

Restart Claude Code afterwards so the new PreToolUse hook is registered. No rule files need changing. The plugin now keeps one small state file per session in the system temp directory, under `jev-rules/`, removed after a week.

## [0.1.0] - 2026-09-18

Initial release.

- UserPromptSubmit hook that reads `.claude/jev-rules/*.md`, asks Jev one yes/no question per rule in a single call, and injects the rules at or above `JEV_RULES_THRESHOLD` (default 0.6) plus any marked `always: true`.
- Fails open on a missing key, timeout, network error, HTTP error or unreadable reply: every rule is injected and the prompt is never blocked.
- Two routes to the same model: TypeSafe's API (`JEV_API_KEY`, `TYPESAFE_API_KEY`) and Vercel AI Gateway (`AI_GATEWAY_API_KEY`). Node 20.12+, no dependencies.
- `JEV_DEBUG=1` decision log at `~/.jev-rules.log`, three example rules, offline tests and a live script.

[0.3.0]: https://github.com/EliaAlberti/jev-rules/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/EliaAlberti/jev-rules/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/EliaAlberti/jev-rules/releases/tag/v0.1.0
