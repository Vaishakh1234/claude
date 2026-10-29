# mcp-hud

A Claude Code mod that adds an **MCP sidebar**: every MCP server in the chat, its tools, and which of them Claude is actually using.

- **Header**: servers connected, tools available, MCP calls made in this chat (a dot pulses while one runs), and the context tokens all MCP tool schemas take up.
- **Server cards**: status (green connected, amber needs sign-in, red failed, grey connecting or disabled) with the error when there is one, tool count, how many tools were used, schema tokens, when it was last used, and its calls and failures. The thin bar compares each server's context weight against the heaviest one.
- **Tool lists**: click **▸ Show tools**. Used tools come first with their calls, failures and when they last ran. A running tool pulses, and unused tools are hollow. The right column is each tool's schema size, or `deferred` while it waits behind ToolSearch.
- **Search and filters**: search servers and tools, **Used** to see only what this chat touched, **Expand all**, **Refresh**.

Calls are counted from the main session and its subagents alike.

## Install

```bash
claude plugin install mcp-hud --marketplace Vaishakh1234/claude
```

From a local clone of the repo, `claude plugin install mcp-hud@vaishakh-claude` once the clone is added as a marketplace (see the repository README). Start a new session afterwards.

## Commands

| Command | What it does |
| --- | --- |
| `/mcp-hud` | Toggle the sidebar |
| `/mcp-hud open` | Open it, or bring it forward |
| `/mcp-hud close` | Close it |
| `/mcp-hud refresh` | Re-read the servers and print a one-line summary |

## Where the data comes from

- Servers and tools: the session's context breakdown (each MCP tool with its server and schema tokens, estimated locally, with no API call), plus the tool list. Re-read at 5s, 15s and 30s after a session starts (servers connect late), then every minute, and on **Refresh**.
- Servers that failed, need sign-in or are still connecting have no tools to list. They show up once Claude's ToolSearch or WaitForMcpServers reports them.
- Calls: a `tool.call` hook sees every `mcp__…` call in the chat. Counts start when the session does and are kept across reloads of the mod.

## Settings

`openOnStart`: `no` (default) or `yes` to open the sidebar in every new session. Set it in `/config`, or in `~/.claude/settings.json`:

```json
{ "pluginConfigs": { "mcp-hud": { "options": { "openOnStart": "yes" } } } }
```

## Develop

```bash
claude plugin validate mods/mcp-hud
```

```bash
claude plugin test mods/mcp-hud
```

Built and tested on Claude Code 2.1.309. Mods use function hooks, an early-access API that may change between releases.
