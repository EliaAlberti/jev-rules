---
description: Ask whether to switch on the jev-rules pane, which lists every rule and lights up the ones Jev picks
---

Ask the person one question with the AskUserQuestion tool, with exactly this input and nothing added:

{"questions":[{"question":"Turn on the jev-rules pane? It lists every rule beside the conversation and lights up the ones Jev picks.","header":"Rules pane","multiSelect":false,"options":[{"label":"Yes, turn it on","description":"Adds \"CLAUDE_CODE_ENABLE_FUNCTION_HOOKS\": \"1\" to the env block of ~/.claude/settings.json. It is an early-access Claude Code setting, and other installed plugins with panes load theirs too. Takes effect after a restart."},{"label":"Not now","description":"Nothing changes. jev-rules asks again in a later session."},{"label":"Don't ask again","description":"Nothing changes, and jev-rules does not ask again. /jev-rules:pane asks at any time."}]}]}

jev-rules applies the answer itself. Do not edit any settings file and do not run any command for it. After the answer, stop.
