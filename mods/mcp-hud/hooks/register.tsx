import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, ToolInfo } from 'claude-code'

import type { McpServer, ServerStatus, ToolUse, View } from '../types'

const PANE = 'mcp-hud'
const PANE_TITLE = 'MCP'

// Bump a shape tag when that value's fields change: the new code then starts
// clean instead of reading what an older version stored (it outlives a reload).
const servers = atom({ plugin: 'mcp-hud', key: 'servers' } as const, [], { shape: 'servers-1' })
const usage = atom({ plugin: 'mcp-hud', key: 'usage' } as const, {}, { shape: 'usage-1' })
const view = atom({ plugin: 'mcp-hud', key: 'view' } as const, { filter: 'all', expanded: [], query: '', refreshedAt: 0 }, { shape: 'view-1' })
const now = atom({ plugin: 'mcp-hud', key: 'now' } as const, 0)

const ACCENT = '#7c6cf2'
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,sans-serif"
const MAX_TOOL_ROWS = 180

const STATUS_COLOR: Record<ServerStatus, string> = {
  connected: '#3fa66b',
  'needs-auth': '#d99a22',
  pending: '#9a9a96',
  failed: '#d0453f',
  disabled: '#9a9a96',
}
const STATUS_LABEL: Record<ServerStatus, string> = {
  connected: 'connected',
  'needs-auth': 'needs sign-in: run /mcp',
  pending: 'connecting',
  failed: 'failed to connect',
  disabled: 'disabled',
}
const STATUS_RANK: Record<ServerStatus, number> = { connected: 0, 'needs-auth': 1, pending: 2, failed: 3, disabled: 4 }

// ---------------------------------------------------------------------------
// Small helpers

// `mcp__claude_ai_Gmail__create_draft` → { key: 'claude_ai_Gmail', short: 'create_draft' }
const splitName = (wire: string): { key: string; short: string } | null => {
  if (!wire.startsWith('mcp__')) return null
  const rest = wire.slice(5)
  const at = rest.indexOf('__')
  return at > 0 ? { key: rest.slice(0, at), short: rest.slice(at + 2) } : null
}

// A server's name as /mcp lists it, spelled the way its tool names spell it.
const keyOf = (name: string): string => name.replace(/[^A-Za-z0-9_-]/g, '_')

const xml = (s: string): string =>
  s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c)

// Rough advance of UI text in em, enough to size a text slot in an SVG.
const charEm = (ch: string): number =>
  /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFF00-\uFF60\u{1F300}-\u{1FAFF}]/u.test(ch)
    ? 1
    : /[\s.,:;'|!il1()[\]]/.test(ch)
      ? 0.3
      : /[A-Zmw@%_]/.test(ch)
        ? 0.72
        : 0.56

const textWidth = (s: string, size: number): number => [...s].reduce((w, ch) => w + charEm(ch) * size, 0)

const fitText = (s: string, size: number, maxW: number): string => {
  if (textWidth(s, size) <= maxW) return s
  let out = ''
  for (const ch of s) {
    if (textWidth(out + ch + '…', size) > maxW) break
    out += ch
  }
  return out + '…'
}

const fmtTokens = (n: number): string =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k` : `${Math.round(n)}`

const fmtAgo = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 10) return 'just now'
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  return `${Math.floor(s / 3600)}h ago`
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

const blankUse = (): ToolUse => ({ calls: 0, errors: 0, running: 0, bySubagents: 0, lastAt: 0, totalMs: 0 })

// ---------------------------------------------------------------------------
// The catalog: which MCP servers and tools this session has

type Reported = { name: string; status: ServerStatus; error?: string }

// MCP tools as the context carries them (server name, tokens), plus any the
// tool list has that the context does not.
async function readCatalog($: EngineInterface): Promise<McpServer[]> {
  const [context, listed] = await Promise.all([
    $.session.usage({ breakdown: 'summary' }).catch(() => null),
    $.tool.list().catch((): ToolInfo[] => []),
  ])
  const byKey = new Map<string, McpServer>()
  const add = (wire: string, serverName: string, tokens: number, isLoaded: boolean) => {
    const parts = splitName(wire)
    if (!parts) return
    const server = byKey.get(parts.key) ?? { key: parts.key, name: serverName || parts.key, status: 'connected', tools: [] }
    if (serverName) server.name = serverName
    if (!server.tools.some(t => t.name === wire)) server.tools.push({ name: wire, short: parts.short, tokens, isLoaded })
    byKey.set(parts.key, server)
  }
  for (const t of context?.context.breakdown?.mcpTools ?? []) add(t.name, t.serverName, t.tokens, t.isLoaded)
  for (const t of listed) if (t.mcp) add(t.name, '', 0, true)
  return [...byKey.values()]
}

// Servers with tools are connected; one known before only by a status
// (failed, needs sign-in, connecting) stays listed until it connects.
const mergeServers = (prev: McpServer[], found: McpServer[]): McpServer[] => {
  const seen = new Set(found.map(s => s.key))
  return [...found, ...prev.filter(s => !seen.has(s.key) && s.status !== 'connected')]
}

const names = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

// What ToolSearch and WaitForMcpServers say about servers, read from their results.
const reportedBy = (tool: string, result: unknown): Reported[] => {
  if (!result || typeof result !== 'object') return []
  const r = result as Record<string, unknown>
  if (tool === 'ToolSearch') {
    const failed = Array.isArray(r.failed_mcp_servers) ? (r.failed_mcp_servers as unknown[]) : []
    return [
      ...names(r.pending_mcp_servers).map((name): Reported => ({ name, status: 'pending' })),
      ...failed.flatMap((f): Reported[] => {
        if (!f || typeof f !== 'object') return []
        const { name, error, errorCode } = f as Record<string, unknown>
        if (typeof name !== 'string') return []
        const why = typeof error === 'string' ? error : typeof errorCode === 'string' ? errorCode : undefined
        return [{ name, status: 'failed', error: why?.slice(0, 120) }]
      }),
    ]
  }
  return [
    ...names(r.connected).map((name): Reported => ({ name, status: 'connected' })),
    ...names(r.stillPending).map((name): Reported => ({ name, status: 'pending' })),
    ...names(r.needsAuth).map((name): Reported => ({ name, status: 'needs-auth' })),
    ...names(r.failed).map((name): Reported => ({ name, status: 'failed' })),
    ...names(r.disabled).map((name): Reported => ({ name, status: 'disabled' })),
  ]
}

const applyReported = (prev: McpServer[], reported: Reported[]): McpServer[] => {
  const next = [...prev]
  for (const r of reported) {
    const key = keyOf(r.name)
    const i = next.findIndex(s => s.key === key || s.name === r.name)
    const found = next[i]
    if (!found) {
      next.push({ key, name: r.name, status: r.status, tools: [], error: r.error })
      continue
    }
    // "Connecting" never demotes a server whose tools are already here.
    const status = r.status === 'pending' && found.tools.length ? found.status : r.status
    next[i] = { ...found, name: r.name, status, error: status === 'connected' ? undefined : (r.error ?? found.error) }
  }
  return next
}

async function refresh($: EngineInterface): Promise<void> {
  const found = await readCatalog($)
  const at = await $.clock.now()
  await update($, servers, prev => mergeServers(prev, found))
  await update($, view, v => ({ ...v, refreshedAt: at }))
  await update($, now, () => at)
}

// ---------------------------------------------------------------------------
// What the sidebar draws, worked out once per draw

type ToolRow = { name: string; short: string; tokens: number; isLoaded: boolean; use: ToolUse }

type ServerRow = McpServer & {
  calls: number
  errors: number
  running: number
  used: number
  lastAt: number
  tokens: number
  isExpanded: boolean
  rows: ToolRow[]
  hidden: number
}

const rowsOf = (list: McpServer[], uses: Record<string, ToolUse>, v: View): ServerRow[] => {
  const q = v.query.trim().toLowerCase()
  // Calls to a tool the catalog has not listed yet still show, under their server.
  const known = new Set(list.flatMap(s => s.tools.map(t => t.name)))
  const extra = new Map<string, McpServer>()
  for (const name of Object.keys(uses)) {
    const parts = splitName(name)
    if (!parts || known.has(name)) continue
    const host = list.find(s => s.key === parts.key) ?? extra.get(parts.key) ?? { key: parts.key, name: parts.key, status: 'connected', tools: [] }
    extra.set(parts.key, { ...host, tools: [...host.tools, { name, short: parts.short, tokens: 0, isLoaded: true }] })
  }
  const all = [...list.map(s => extra.get(s.key) ?? s), ...[...extra.values()].filter(s => !list.some(l => l.key === s.key))]

  return all
    .map((s): ServerRow => {
      const tools = s.tools.map((t): ToolRow => ({ ...t, use: uses[t.name] ?? blankUse() }))
      const isMatch = (t: ToolRow) => !q || s.name.toLowerCase().includes(q) || t.short.toLowerCase().includes(q)
      const shown = tools
        .filter(t => isMatch(t) && (v.filter === 'all' || t.use.calls > 0 || t.use.running > 0))
        .sort((a, b) => b.use.running - a.use.running || b.use.calls - a.use.calls || a.short.localeCompare(b.short))
      return {
        ...s,
        calls: tools.reduce((n, t) => n + t.use.calls, 0),
        errors: tools.reduce((n, t) => n + t.use.errors, 0),
        running: tools.reduce((n, t) => n + t.use.running, 0),
        used: tools.filter(t => t.use.calls > 0).length,
        lastAt: Math.max(0, ...tools.map(t => t.use.lastAt)),
        tokens: tools.reduce((n, t) => n + t.tokens, 0),
        // A search opens every server it matches.
        isExpanded: v.expanded.includes(s.key) || (q !== '' && shown.length > 0),
        rows: shown.slice(0, MAX_TOOL_ROWS),
        hidden: Math.max(0, shown.length - MAX_TOOL_ROWS),
      }
    })
    .filter(s => (v.filter === 'all' || s.calls > 0 || s.running > 0) && (!q || s.rows.length > 0 || s.name.toLowerCase().includes(q)))
    .sort(
      (a, b) =>
        b.running - a.running ||
        b.calls - a.calls ||
        STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
        a.name.localeCompare(b.name),
    )
}

const totalsOf = (list: McpServer[], uses: Record<string, ToolUse>) => {
  const all = Object.entries(uses).filter(([name]) => splitName(name))
  return {
    connected: list.filter(s => s.status === 'connected').length,
    servers: list.length,
    tools: list.reduce((n, s) => n + s.tools.length, 0),
    calls: all.reduce((n, [, u]) => n + u.calls, 0),
    running: all.reduce((n, [, u]) => n + u.running, 0),
    tokens: list.reduce((n, s) => n + s.tools.reduce((m, t) => m + t.tokens, 0), 0),
  }
}

const serverLine = (s: ServerRow, at: number): string => {
  if (s.status !== 'connected') return s.error ? `${STATUS_LABEL[s.status]} · ${s.error}` : STATUS_LABEL[s.status]
  const parts = [plural(s.tools.length, 'tool'), `${s.used} used`]
  if (s.tokens) parts.push(`${fmtTokens(s.tokens)} tokens`)
  if (s.lastAt) parts.push(`last ${fmtAgo(at - s.lastAt)}`)
  return parts.join(' · ')
}

const callsWord = (s: { calls: number; errors: number; running: number }): string =>
  s.running ? `${s.running} running` : s.calls ? `${plural(s.calls, 'call')}${s.errors ? ` · ${s.errors} failed` : ''}` : 'unused'

const toolUseText = (t: ToolRow, at: number): string => {
  if (t.use.running) return 'running…'
  if (!t.use.calls) return t.isLoaded ? '' : 'deferred'
  const parts = [`${t.use.calls}×`]
  if (t.use.errors) parts.push(`${t.use.errors} failed`)
  parts.push(fmtAgo(at - t.use.lastAt))
  return parts.join(' · ')
}

// ---------------------------------------------------------------------------
// Desktop drawings. A desktop row wraps sibling elements onto new lines, so
// each card is one SVG; ids are prefixed, as several SVGs share a page.

const SVG_CSS = `<style>
.t{fill:#1f1f1f}.s{fill:#6b6b68}.m{fill:#9a9a96}.k{fill:#ebeae6}.ln{stroke:#e6e5e2}.tile{fill:#f4f3f0}.row{fill:#f7f6f3}
@media (prefers-color-scheme: dark){.t{fill:#ececec}.s{fill:#a8a8a4}.m{fill:#7d7d79}.k{fill:#2e2e2d}.ln{stroke:#333331}.tile{fill:#262625}.row{fill:#232322}}
.live{animation:pulse 1.4s ease-in-out infinite}@keyframes pulse{50%{opacity:.3}}
@media (prefers-reduced-motion: reduce){.live{animation:none}}
</style>`

const svg = (W: number, H: number, body: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${SVG_CSS}${body}</svg>`

const HEADER_H = 44

const headerSvg = (W: number, t: ReturnType<typeof totalsOf>): string => {
  const gap = 6
  const tw = (W - gap * 3) / 4
  const tile = (i: number, k: string, v: string, live = false) =>
    `<rect class="tile" x="${i * (tw + gap)}" y="0" width="${tw}" height="40" rx="8"/>
<text class="s" x="${i * (tw + gap) + 9}" y="15" font-family="${FONT}" font-size="11">${k}</text>
${live ? `<circle class="live" cx="${i * (tw + gap) + tw - 10}" cy="11" r="3.5" fill="${ACCENT}"/>` : ''}
<text class="t" x="${i * (tw + gap) + 9}" y="32" font-family="${FONT}" font-size="15" font-weight="600" font-variant-numeric="tabular-nums">${v}</text>`
  return svg(
    W,
    HEADER_H,
    tile(0, 'Servers', `${t.connected}${t.servers > t.connected ? ` / ${t.servers}` : ''}`) +
      tile(1, 'Tools', `${t.tools}`) +
      tile(2, 'Calls', `${t.calls}`, t.running > 0) +
      tile(3, 'Context', fmtTokens(t.tokens)),
  )
}

const SERVER_H = 50

const serverSvg = (W: number, s: ServerRow, at: number, maxTokens: number): string => {
  const color = STATUS_COLOR[s.status]
  const right = callsWord(s)
  const rightW = textWidth(right, 12) + 4
  const share = maxTokens ? s.tokens / maxTokens : 0
  return svg(
    W,
    SERVER_H,
    `<circle class="${s.running ? 'live' : ''}" cx="8" cy="15" r="4.5" fill="${s.running ? ACCENT : color}"/>
<text class="t" x="22" y="19" font-family="${FONT}" font-size="13" font-weight="600">${xml(fitText(s.name, 13, W - 30 - rightW))}</text>
<text class="${s.calls || s.running ? 't' : 'm'}" x="${W - 2}" y="19" text-anchor="end" font-family="${FONT}" font-size="12" font-variant-numeric="tabular-nums"${s.running ? ` fill="${ACCENT}"` : ''}>${xml(right)}</text>
<text class="s" x="22" y="35" font-family="${FONT}" font-size="11"${s.status === 'connected' ? '' : ` fill="${color}"`}>${xml(fitText(serverLine(s, at), 11, W - 24))}</text>
<rect class="k" x="22" y="41" width="${W - 24}" height="3" rx="1.5"/>
<rect x="22" y="41" width="${Math.round((W - 24) * share)}" height="3" rx="1.5" fill="${color}" opacity=".7"/>
<line class="ln" x1="0" y1="${SERVER_H - 0.5}" x2="${W}" y2="${SERVER_H - 0.5}"/>`,
  )
}

const TOOL_H = 22

const toolsSvg = (W: number, s: ServerRow, at: number): string => {
  const rows = s.rows.map((t, i) => {
    const y = i * TOOL_H
    const mark = t.use.running
      ? `<circle class="live" cx="30" cy="${y + 11}" r="3.5" fill="${ACCENT}"/>`
      : t.use.calls
        ? `<circle cx="30" cy="${y + 11}" r="3.5" fill="${t.use.errors === t.use.calls ? STATUS_COLOR.failed : STATUS_COLOR.connected}"/>`
        : `<circle cx="30" cy="${y + 11}" r="3" fill="none" stroke="#9a9a96" stroke-width="1.2"/>`
    const useText = toolUseText(t, at)
    const tokens = t.tokens ? fmtTokens(t.tokens) : ''
    const useW = textWidth(useText, 11) + 10
    return `${i % 2 ? '' : `<rect class="row" x="20" y="${y}" width="${W - 20}" height="${TOOL_H}" rx="4"/>`}
${mark}
<text class="${t.use.calls || t.use.running ? 't' : 's'}" x="42" y="${y + 15}" font-family="${FONT}" font-size="12">${xml(fitText(t.short, 12, W - 42 - useW - 48))}</text>
<text class="${t.use.running ? '' : 's'}" x="${W - 46}" y="${y + 15}" text-anchor="end" font-family="${FONT}" font-size="11" font-variant-numeric="tabular-nums"${t.use.running ? ` fill="${ACCENT}"` : ''}>${xml(useText)}</text>
<text class="m" x="${W - 4}" y="${y + 15}" text-anchor="end" font-family="${FONT}" font-size="10" font-variant-numeric="tabular-nums">${tokens}</text>`
  })
  const more = s.hidden ? `<text class="m" x="42" y="${s.rows.length * TOOL_H + 15}" font-family="${FONT}" font-size="11">+${s.hidden} more: search to narrow</text>` : ''
  return svg(W, s.rows.length * TOOL_H + (s.hidden ? TOOL_H : 0) + 4, rows.join('') + more)
}

// ---------------------------------------------------------------------------
// Opening the sidebar

async function openPane($: EngineInterface): Promise<void> {
  await $.ui.open({ id: PANE, title: PANE_TITLE })
  await refresh($)
}

// Opens the sidebar, or closes it when it is up; true when it ends up open.
async function togglePane($: EngineInterface): Promise<boolean> {
  if ((await $.ui.panes()).some(p => p.id === PANE)) {
    await $.ui.close({ id: PANE })
    return false
  }
  await openPane($)
  return true
}

async function toggleServer($: EngineInterface, key: string): Promise<void> {
  await update($, view, v => ({
    ...v,
    expanded: v.expanded.includes(key) ? v.expanded.filter(k => k !== key) : [...v.expanded, key],
  }))
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'mcp-hud',
      description: 'Show or hide the MCP sidebar: servers, tools and calls in this chat (args: open, close, refresh)',
    })

    // Servers connect after the session starts: look again at 5s, 15s and 30s,
    // then once a minute. In between, tick the clock the "ago" labels read.
    let tick = 0
    $.clock.every(5000, () => {
      tick += 1
      if (tick === 1 || tick === 3 || tick === 6 || tick % 12 === 0) void refresh($).catch(() => {})
      else if (tick % 3 === 0)
        void (async () => {
          const at = await $.clock.now()
          await update($, now, () => at)
        })().catch(() => {})
    })
    await refresh($).catch(() => {})
    if (options.openOnStart === 'yes') void $.ui.open({ id: PANE, title: PANE_TITLE })
    return started
  })

  on('command.run', { command: 'mcp-hud' }, async ($, e) => {
    const arg = (e.args ?? '').trim().toLowerCase()
    if (arg === 'open') {
      await openPane($)
      return { text: 'MCP sidebar opened.' }
    }
    if (arg === 'close') {
      await $.ui.close({ id: PANE })
      return { text: 'MCP sidebar closed.' }
    }
    if (arg === 'refresh') {
      await refresh($)
      const t = totalsOf(await read($, servers), await read($, usage))
      return { text: `MCP: ${plural(t.connected, 'server')} connected, ${plural(t.tools, 'tool')}, ${plural(t.calls, 'call')} so far.` }
    }
    return { text: (await togglePane($)) ? 'MCP sidebar opened.' : 'MCP sidebar closed.' }
  })

  // Every MCP tool call of the chat, the subagents' included: count it, time it,
  // and note whether it failed. ToolSearch and WaitForMcpServers report which
  // servers failed, wait for sign-in or are still connecting.
  on('tool.call', async ($, e, next) => {
    if (e.tool === 'ToolSearch' || e.tool === 'WaitForMcpServers') {
      const ran = await next(e)
      const reported = reportedBy(e.tool, ran.result)
      if (reported.length) {
        await update($, servers, prev => applyReported(prev, reported))
        if (reported.some(r => r.status === 'connected')) void refresh($).catch(() => {})
      }
      return ran
    }

    const parts = splitName(e.tool)
    if (!parts) return next(e)
    const name = e.tool
    const startedAt = await $.clock.now()
    await update($, usage, u => ({ ...u, [name]: { ...(u[name] ?? blankUse()), running: (u[name]?.running ?? 0) + 1 } }))
    let isError = true
    try {
      const ran = await next(e)
      isError = ran.deny !== undefined || ran.isError === true
      return ran
    } finally {
      const at = await $.clock.now()
      await update($, usage, u => {
        const was = u[name] ?? blankUse()
        return {
          ...u,
          [name]: {
            calls: was.calls + 1,
            errors: was.errors + (isError ? 1 : 0),
            running: Math.max(0, was.running - 1),
            bySubagents: was.bySubagents + (e.agentId ? 1 : 0),
            lastAt: at,
            totalMs: was.totalMs + (at - startedAt),
          },
        }
      })
      await update($, now, () => at)
      // A tool of a server the catalog has not seen yet: look again.
      if (!(await read($, servers)).some(s => s.key === parts.key)) void refresh($).catch(() => {})
    }
    // A failure here must never stop the tool call: replay or run it as is.
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const list = await read($, servers)
    const uses = await read($, usage)
    const v = await read($, view)
    const at = Math.max(await read($, now), v.refreshedAt)
    const t = totalsOf(list, uses)
    const rows = rowsOf(list, uses, v)
    const usedCount = rowsOf(list, uses, { ...v, filter: 'used', query: '' }).length
    const isAllOpen = rows.length > 0 && rows.every(r => r.isExpanded)

    // Mobile draws no fields yet: it shows the list without the search.
    const search =
      'Input' in ui ? (
        <ui.Input
          key="search"
          placeholder="Search servers and tools"
          value={v.query}
          onInput={(q: string) => update($, view, prev => ({ ...prev, query: q }))}
          onSubmit={(q: string) => update($, view, prev => ({ ...prev, query: q }))}
        />
      ) : null
    const controls = (
      <Box flexDirection="row" gap={2}>
        <Button
          key="filter-all"
          label={`${v.filter === 'all' ? '● ' : ''}All · ${t.servers}`}
          plain
          dimColor={v.filter !== 'all'}
          onPress={() => update($, view, prev => ({ ...prev, filter: 'all' as const }))}
        />
        <Button
          key="filter-used"
          label={`${v.filter === 'used' ? '● ' : ''}Used · ${usedCount}`}
          plain
          dimColor={v.filter !== 'used'}
          onPress={() => update($, view, prev => ({ ...prev, filter: 'used' as const }))}
        />
        <Button
          key="expand-all"
          label={isAllOpen ? 'Collapse all' : 'Expand all'}
          plain
          dimColor
          onPress={() => update($, view, prev => ({ ...prev, expanded: isAllOpen ? [] : rows.map(r => r.key) }))}
        />
        <Button key="refresh" label="↻ Refresh" plain dimColor onPress={() => refresh($)} />
      </Box>
    )
    const empty =
      rows.length === 0 ? (
        <Text dimColor>
          {list.length === 0
            ? 'No MCP servers found yet. Servers connect after a session starts: try Refresh in a few seconds.'
            : v.filter === 'used'
              ? 'No MCP tool has been called in this chat yet.'
              : 'Nothing matches the search.'}
        </Text>
      ) : null
    const footer = (
      <Text dimColor>
        Calls counted since this chat started{v.refreshedAt ? ` · list updated ${fmtAgo(at - v.refreshedAt)}` : ''}
      </Text>
    )
    const toggleLabel = (r: ServerRow) =>
      r.isExpanded ? '▾ Hide tools' : `▸ Show ${plural(r.rows.length + r.hidden, v.filter === 'used' ? 'used tool' : 'tool')}`

    if (e.surface !== 'terminal' && 'Svg' in ui) {
      const { Svg } = ui
      const W = Math.max(260, Math.min(900, (e.props.bodyColumns || 40) * 8 - 8))
      const maxTokens = Math.max(0, ...rows.map(r => r.tokens))
      return (
        <Box flexDirection="column" gap={1}>
          <Svg source={headerSvg(W, t)} alt={`${t.connected} servers, ${t.tools} tools, ${t.calls} calls`} width={W} height={HEADER_H} />
          {search}
          {controls}
          {empty}
          {rows.map(r => (
            <Box key={r.key} flexDirection="column">
              <Svg source={serverSvg(W, r, at, maxTokens)} alt={`${r.name}: ${STATUS_LABEL[r.status]}, ${callsWord(r)}`} width={W} height={SERVER_H} />
              {(r.rows.length > 0 || r.hidden > 0) && (
                <Button key={`toggle-${r.key}`} label={toggleLabel(r)} plain dimColor onPress={() => toggleServer($, r.key)} />
              )}
              {r.isExpanded && r.rows.length > 0 && (
                <Svg
                  source={toolsSvg(W, r, at)}
                  alt={`${r.name} tools: ${r.rows.map(x => x.short).join(', ')}`}
                  width={W}
                  height={r.rows.length * TOOL_H + (r.hidden ? TOOL_H : 0) + 4}
                />
              )}
            </Box>
          ))}
          {footer}
        </Box>
      )
    }

    // Terminal: the same list in text rows.
    return (
      <Box flexDirection="column">
        <Text>
          <Text bold>{t.connected}</Text>
          <Text dimColor>{t.servers > t.connected ? `/${t.servers}` : ''} servers · </Text>
          <Text bold>{t.tools}</Text>
          <Text dimColor> tools · </Text>
          <Text bold color={t.running ? ACCENT : undefined}>{t.calls}</Text>
          <Text dimColor> calls · </Text>
          <Text bold>{fmtTokens(t.tokens)}</Text>
          <Text dimColor> tokens</Text>
        </Text>
        {search}
        {controls}
        <Box flexDirection="column" marginTop={1}>
          {empty}
          {rows.map(r => (
            <Box key={r.key} flexDirection="column" marginBottom={1}>
              <Text wrap="truncate-end">
                <Text color={r.running ? ACCENT : STATUS_COLOR[r.status]}>● </Text>
                <Text bold>{r.name}</Text>
                <Text dimColor> · {callsWord(r)}</Text>
              </Text>
              <Text dimColor wrap="truncate-end">
                {'  '}
                {serverLine(r, at)}
              </Text>
              {(r.rows.length > 0 || r.hidden > 0) && (
                <Button key={`toggle-${r.key}`} label={`  ${toggleLabel(r)}`} plain dimColor onPress={() => toggleServer($, r.key)} />
              )}
              {r.isExpanded &&
                r.rows.map(x => (
                  <Text key={x.name} wrap="truncate-end">
                    {'    '}
                    <Text color={x.use.running ? ACCENT : x.use.calls ? STATUS_COLOR.connected : undefined} dimColor={!x.use.calls && !x.use.running}>
                      {x.use.running ? '◉' : x.use.calls ? '●' : '○'}{' '}
                    </Text>
                    <Text dimColor={!x.use.calls && !x.use.running}>{x.short}</Text>
                    <Text dimColor> {toolUseText(x, at)}</Text>
                  </Text>
                ))}
              {r.isExpanded && r.hidden > 0 && <Text dimColor>    +{r.hidden} more: search to narrow</Text>}
            </Box>
          ))}
        </Box>
        {footer}
      </Box>
    )
  })
}
