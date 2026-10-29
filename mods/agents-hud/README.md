# agents-hud

A Claude Code mod that shows what your subagents are doing while they work.

- **Progress bar above the prompt.** While subagents run, it shows how many of the current batch have finished. When Claude reports a plan through the `progress` tool, it shows the plan's title, phase and tasks done out of planned. `Agents ×N` opens the panel, and `✕` hides the plan's row.
- **Agents panel** (`/agents-hud`): every subagent of the session, running and finished, with its type, model, effort, elapsed time, estimated cost, context fill and its own step progress. Planned tasks that have not started yet are listed underneath.

It draws natively on both the terminal and the desktop app (SVG rows there, with light and dark themes).

## Commands

| Command | What it does |
| --- | --- |
| `/agents-hud` | Toggle the panel |
| `/agents-hud open` | Open it, or bring it forward |
| `/agents-hud close` | Close it |
| `/agents-hud clear` | Drop finished agents and the plan |

## Tools it adds

- `mcp__agents-hud__progress`: the main session reports a plan (`title`, `tasks`, `phase`), tasks done (`done`) and the end (`finished: true`). A call from a subagent is ignored. It sits behind ToolSearch, so Claude uses it when asked, for example: *"plan this, then track it with the agents-hud progress tool"*. Use each task title as the Agent description and the panel matches runs to tasks.
- `mcp__agents-hud__step`: a subagent reports its own steps (`done`, `total`, `note`). It is listed up front so subagents see it. A subagent that does not report shows its context fill in grey instead.

Cost is a rough estimate from token counts and the price table in `hooks/register.tsx` (`PRICES`), not a bill.

## Settings

`autoOpen`: `agents` (default) opens the panel when the first subagent of a session starts or a plan is reported, `plan` only when a plan is reported, and `never` leaves it to `/agents-hud`. Set it in `/config`, or in `~/.claude/settings.json`:

```json
{ "pluginConfigs": { "agents-hud": { "options": { "autoOpen": "plan" } } } }
```

## Develop

```bash
claude plugin validate mods/agents-hud
```

```bash
claude plugin test mods/agents-hud
```

Mods are built on function hooks, an early-access Claude Code API that may change between releases. This one was built and tested on Claude Code 2.1.309.

## Credits

Inspired by [savvy-progress](https://github.com/JohnnyVizz/claude-kit/tree/main/plugins/savvy-progress), with a few helpers (price table, model names, text fitting, band nesting) adapted from it. MIT License, Copyright (c) 2026 johnnyvizz.
