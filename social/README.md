# Social assets

Real captures of jev-rules working inside Claude Code, for the README and for social posts. Nothing here is staged: each still comes from a live Claude Code session (v2.1.276, Opus 5) in the demo project under `demo/shop`, and the right-hand pane is a live view of the real `~/.jev-rules.log`.

- `stills/`: key stills at 1920 x 1080, exact 16:9, title bar cropped. Committed. Full-size originals stay local in `stills/full/`.
- `video/`: raw clips for editing in OpenMontage. Local only (git-ignored).
- `demo/shop/`: the demo project: twelve popular rules, three map documents, and a small checkout module with a genuine discount bug.
- `rig/`: the scripts that produced the captures.

## The four use cases

| # | Use case | Prompt | What it shows | Best stills |
| --- | --- | --- | --- | --- |
| 1 | Before and after | "The checkout total is wrong when a discount is applied. Before you start, list the names of the project rules you were given..." | Before: rules in Claude Code's own `.claude/rules/`, Claude lists all twelve. After: jev-rules, Claude lists one, "1 of 12", plus the checkout map document. | `before-4-answer`, `after-3-decided`, `after-4-answer` |
| 2 | Checkout bug, right rule | "the checkout total is wrong when a discount is applied, fix it..." | Payments rule 0.97 and checkout map 0.91 arrive with the prompt. Claude writes the tests first because the rule says so, then the one-line fix, shown as a diff. Each file change is judged live. | `checkout-3-decided`, `checkout-4-answer` |
| 3 | Rule follows the file | "NOTES.txt names one file. In that file, rename the parameter percent to pct..." | The hero shot. The vague prompt scores everything near zero (payments 0.13). Then the change to `src/checkout/discount.ts` lights up payments-need-tests at 0.97, and Claude explains when the rule reached it. | `follow-3-decided`, `follow-4-answer` |
| 4 | Ship it, get the checklist | "tag v1.4.0 and ship it to production. Walk me through what you will do first..." | Deploy checklist 0.98 and the deploy-pipeline map 0.90. Payments, style and the other ten rules stay out. Claude's plan follows the checklist in order. | `ship-3-decided`, `ship-4-answer` |

Committed here are the two key stills per scenario at 1920 x 1080: `3-decided` (the moment Jev decides) and `4-answer` (the reply from Claude). Full 3400 x 1912 originals, including `1-ready` and `2-typed`, stay local in `stills/full/`.

## Suggested captions

- "12 rules in the project. Claude got the 1 that mattered. Jev decided in 476 ms."
- "The prompt said nothing about payments. The file did. Rule delivered."
- "'Ship it' brings the deploy checklist. Not the accessibility rules, not the commit style guide."
- "Keyword matching misses. Judgment does not: one yes/no question per rule, one call per prompt, a fraction of a cent."

## Notes for editing

- In `follow-4-answer`, Claude's reply names the author's global `~/.claude/CLAUDE.md` and `RTK.md`. Harmless, but crop or blur for social if preferred.
- Claude thinks for one to five minutes per reply at max effort. Speed-ramp or cut the thinking stretches.
- Frames are captured by window id, so nothing else on the screen can appear in a clip, even when other windows cover the demo window. Cap's window mode records the screen area instead, so only use Cap with the demo window in front.

## Reproduce

```bash
node social/rig/drive.mjs follow      # before | after | checkout | follow | ship
```

Needs macOS, Terminal.app, tmux, ffmpeg, Claude Code with jev-rules installed and a key in `~/.jev-rules.env`. The driver never takes keyboard focus, aborts if Claude Code is not on screen or a dialog appears, and keeps the clip in `social/video/`.
