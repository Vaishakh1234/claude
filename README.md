# claude

My Claude Code mods. Each one is a standalone plugin under `mods/`, and the repo itself is a plugin marketplace.

| Mod | What it does |
| --- | --- |
| [agents-hud](mods/agents-hud) | Progress bar above the prompt and a live agents panel (`/agents-hud`) with model, progress, context, cost and time for every subagent. |
| [mcp-hud](mods/mcp-hud) | MCP sidebar (`/mcp-hud`): every MCP server in the chat with its status, tools, context cost and live call counts. |

## Connect it to Claude Code

From the local clone, so edits and `git pull` reach Claude directly:

```bash
claude plugin marketplace add ~/Desktop/web-development/personal/claude
```

```bash
claude plugin install agents-hud@vaishakh-claude
```

```bash
claude plugin install mcp-hud@vaishakh-claude
```

Start a new session afterwards. The plugin is read straight from this folder: after editing a mod, start a new session (or run `/reload-plugins` in a terminal session) to pick it up.

On another machine, install from GitHub instead (needs read access to the repo and a git credential for github.com):

```bash
claude plugin install agents-hud --marketplace Vaishakh1234/claude
```

## Layout

```
.claude-plugin/marketplace.json   the catalog Claude Code reads
mods/<name>/
  .claude-plugin/plugin.json      manifest
  hooks/hooks.json                points at the hooks module
  hooks/register.tsx              the mod itself
  hooks/*.test.tsx                tests, run with `claude plugin test`
  types/index.d.ts                the mod's $.state contract
```

## Adding a mod

1. Make `mods/<name>/` with the files above.
2. Add an entry to `.claude-plugin/marketplace.json`.
3. Check it: `claude plugin validate mods/<name>` and `claude plugin test mods/<name>`.
4. Install it: `claude plugin install <name>@vaishakh-claude`.
