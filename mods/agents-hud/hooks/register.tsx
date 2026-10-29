import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentRun, AgentStatus, Phase, Plan, View } from '../types'

const PANE = 'agents-hud'
const PANE_TITLE = 'Agents'
const PROGRESS_TOOL = 'mcp__agents-hud__progress'
const STEP_TOOL = 'mcp__agents-hud__step'

// Bump a shape tag when that value's fields change: the new code then starts
// clean instead of reading what an older version stored (it outlives a reload).
const plan = atom({ plugin: 'agents-hud', key: 'plan' } as const, null, { shape: 'plan-1' })
const agents = atom({ plugin: 'agents-hud', key: 'agents' } as const, [], { shape: 'agents-1' })
const view = atom({ plugin: 'agents-hud', key: 'view' } as const, {
  isDoneHidden: false,
  isBandHidden: false,
  hasAutoOpened: false,
  batchStartedAt: 0,
}, { shape: 'view-1' })
const now = atom({ plugin: 'agents-hud', key: 'now' } as const, 0)

const PHASES: readonly Phase[] = ['plan', 'work', 'review', 'done']
// A tool's schema is advice to the model, not a check: these bound what a call
// can ask the band and the panel to draw.
const MAX_TASKS = 100
const MAX_TITLE = 80
const MAX_AGENTS = 100

const ACCENT = '#7c6cf2'
const DONE = '#3fa66b'
const FAILED = '#d0453f'
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,sans-serif"

// ---------------------------------------------------------------------------
// Small helpers

const clip = (s: string, max: number): string => (s.length > max ? s.slice(0, max - 1) + '…' : s)

const norm = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

const int = (v: unknown, fallback: number, max: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(0, Math.round(v))) : fallback

const xml = (s: string): string =>
  s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c)

// Rough advance of UI text in em, enough to size a text slot in an SVG.
const charEm = (ch: string): number =>
  /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFF00-\uFF60\u{1F300}-\u{1FAFF}]/u.test(ch)
    ? 1
    : /[\s.,:;'|!il1()[\]]/.test(ch)
      ? 0.3
      : /[A-Zmw@%]/.test(ch)
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
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${Math.round(n)}`

const fmtCost = (usd: number): string => `$${usd < 10 ? usd.toFixed(2) : usd.toFixed(1)}`

const fmtTime = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

const textBar = (ratio: number, width: number): string => {
  const filled = Math.round(width * Math.min(1, Math.max(0, ratio)))
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled))
}

// "claude-opus-5-5" → "Opus 5.5"; anything unrecognised shows as it came.
const modelName = (id: string): string => {
  const m = /(fable|mythos|opus|sonnet|haiku)-(\d+)(?:-(\d{1,2})(?!\d))?/i.exec(id)
  if (!m) return id.replace(/^claude-/, '').replace(/\[.*\]$/, '') || '—'
  const [, family = '', major = '', minor] = m
  return `${family.charAt(0).toUpperCase()}${family.slice(1).toLowerCase()} ${major}${minor ? '.' + minor : ''}`
}

// ---------------------------------------------------------------------------
// Cost: an estimate from token counts, not a bill. USD per million tokens:
// input, output, cache read, cache write. First match wins, so a release sits
// above its family. List prices as of 2026-10; edit when they change.

type Price = [input: number, output: number, cacheRead: number, cacheWrite: number]

const PRICES: [RegExp, Price][] = [
  [/(fable|mythos)-5-1/, [10, 50, 0.25, 20]],
  [/fable|mythos/, [10, 50, 1, 20]],
  [/opus-5-5/, [4, 20, 0.2, 8]],
  [/opus/, [5, 25, 0.5, 10]],
  [/sonnet-5/, [2, 10, 0.2, 4]],
  [/sonnet/, [3, 15, 0.3, 6]],
  [/haiku-5/, [0.1, 0.5, 0.01, 0.2]],
  [/haiku/, [1, 5, 0.1, 2]],
]

type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

const usageTokens = (u: Usage): number =>
  (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0)

const costOf = (model: string, u: Usage): number => {
  const [i, o, r, w] = PRICES.find(([re]) => re.test(model.toLowerCase()))?.[1] ?? [4, 20, 0.2, 8]
  return (
    ((u.input_tokens || 0) * i +
      (u.output_tokens || 0) * o +
      (u.cache_read_input_tokens || 0) * r +
      (u.cache_creation_input_tokens || 0) * w) /
    1e6
  )
}

// Haiku 4.x and the Claude 3 models have a 200K window; the rest 1M.
const windowOf = (model: string): number => (/haiku-4|claude-3/i.test(model) ? 200_000 : 1_000_000)

// ---------------------------------------------------------------------------
// The plan the main session reports

type ProgressInput = {
  title?: unknown
  total?: unknown
  done?: unknown
  phase?: unknown
  finished?: unknown
  tasks?: unknown
}

const blankPlan = (): Plan => ({ title: 'Working', total: 0, done: 0, phase: 'plan', isFinished: false, tasks: [] })

const titleOf = (input: ProgressInput): string | null =>
  typeof input.title === 'string' && input.title.trim() ? clip(input.title.trim(), MAX_TITLE) : null

// A new title, or a report after the last plan finished, starts a new plan.
const isNewPlan = (prev: Plan | null, input: ProgressInput): boolean => {
  const title = titleOf(input)
  return !prev || prev.isFinished || (title !== null && title !== prev.title)
}

const cleanTasks = (tasks: unknown): string[] | null =>
  Array.isArray(tasks)
    ? tasks
        .map(t => (typeof t === 'string' ? t : typeof t === 'object' && t && 'title' in t ? String(t.title) : ''))
        .map(t => t.trim())
        .filter(Boolean)
        .slice(0, MAX_TASKS)
        .map(t => clip(t, MAX_TITLE))
    : null

const mergePlan = (prev: Plan | null, input: ProgressInput): Plan => {
  const base = !prev || isNewPlan(prev, input) ? blankPlan() : prev
  const tasks = cleanTasks(input.tasks) ?? base.tasks
  const total = int(input.total, cleanTasks(input.tasks) ? tasks.length : base.total, MAX_TASKS)
  const done = Math.min(total || MAX_TASKS, int(input.done, base.done, MAX_TASKS))
  const isFinished = input.finished === true
  const phase = PHASES.includes(input.phase as Phase) ? (input.phase as Phase) : base.phase
  return {
    title: titleOf(input) ?? base.title,
    total,
    done,
    phase: isFinished ? 'done' : phase,
    isFinished,
    tasks,
  }
}

const planRatio = (p: Plan): number => (p.isFinished ? 1 : p.total ? p.done / p.total : 0)

const planLabel = (p: Plan, running: number): string => {
  if (p.isFinished) return 'Done'
  const count = p.total ? `${p.done}/${p.total}` : `${running} running`
  if (p.phase === 'plan') return p.total ? `Plan ${count}` : 'Planning'
  return `${p.phase === 'review' ? 'Review' : 'Tasks'} ${count}`
}

// Planned tasks no subagent has started yet: matched by the Agent description.
const pendingTasks = (p: Plan | null, list: AgentRun[]): { n: number; title: string }[] => {
  if (!p || p.isFinished) return []
  const started = new Set(list.map(a => norm(a.description)))
  return p.tasks.map((title, i) => ({ n: i + 1, title })).filter(t => !started.has(norm(t.title)))
}

// ---------------------------------------------------------------------------
// What the band shows: the reported plan, else the current batch of subagents.

type Summary = {
  title: string
  ratio: number
  label: string
  isFinished: boolean
  isWorking: boolean
  crew: number
}

const summarize = (p: Plan | null, list: AgentRun[], v: View): Summary | null => {
  const running = list.filter(a => a.status === 'running').length
  if (p && !v.isBandHidden) {
    return {
      title: p.title,
      ratio: planRatio(p),
      label: planLabel(p, running),
      isFinished: p.isFinished,
      isWorking: running > 0,
      crew: list.length + pendingTasks(p, list).length,
    }
  }
  if (running === 0) return null
  const batch = list.filter(a => a.startedAt >= v.batchStartedAt)
  const finished = batch.filter(a => a.status !== 'running').length
  return {
    title: 'Subagents',
    ratio: batch.length ? finished / batch.length : 0,
    label: `${finished}/${batch.length} · ${running} running`,
    isFinished: false,
    isWorking: true,
    crew: list.length,
  }
}

const totals = (list: AgentRun[], at: number) => {
  const cost = list.reduce((s, a) => s + a.costUsd, 0)
  const tokens = list.reduce((s, a) => s + a.tokens, 0)
  if (!list.length) return { cost, tokens, time: 0 }
  const start = Math.min(...list.map(a => a.startedAt))
  const end = Math.max(...list.map(a => a.endedAt ?? Math.max(at, a.startedAt)))
  return { cost, tokens, time: end - start }
}

const elapsed = (a: AgentRun, at: number): number => (a.endedAt ?? Math.max(at, a.startedAt)) - a.startedAt

const ctxPct = (a: AgentRun): number => Math.min(100, Math.round((a.contextTokens / windowOf(a.model)) * 100))

// The run's own progress when it reports steps; a finished run is full; else null.
const progressOf = (a: AgentRun): number | null => {
  if (a.status === 'done') return 1
  if (a.stepTotal) return Math.min(1, (a.stepDone ?? 0) / a.stepTotal)
  return null
}

const STATUS_COLOR: Record<AgentStatus, string> = { running: ACCENT, done: DONE, failed: FAILED, stopped: '#9a9a96' }
const STATUS_GLYPH: Record<AgentStatus, string> = { running: '●', done: '✓', failed: '✗', stopped: '■' }

// ---------------------------------------------------------------------------
// Desktop drawings. A desktop row wraps sibling elements onto new lines, so
// each row is one SVG. Ids are prefixed per drawing: several SVGs share a page.

const SVG_CSS = `<style>
.t{fill:#1f1f1f}.s{fill:#6b6b68}.m{fill:#9a9a96}.k{fill:#ebeae6}.ln{stroke:#e6e5e2}.tile{fill:#f4f3f0}
@media (prefers-color-scheme: dark){.t{fill:#ececec}.s{fill:#a8a8a4}.m{fill:#7d7d79}.k{fill:#2e2e2d}.ln{stroke:#333331}.tile{fill:#262625}}
.live{animation:pulse 1.6s ease-in-out infinite}@keyframes pulse{50%{opacity:.3}}
.shine{animation:shine 1.8s linear infinite}@keyframes shine{from{transform:translateX(-80px)}to{transform:translateX(100%)}}
@media (prefers-reduced-motion: reduce){.live,.shine{animation:none}}
</style>`

const svg = (W: number, H: number, body: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${SVG_CSS}${body}</svg>`

// A rounded bar with a moving shine while work runs.
const barSvg = (id: string, x: number, y: number, w: number, h: number, ratio: number, color: string, isWorking: boolean, ticks = 0): string => {
  const fillW = Math.round(w * Math.min(1, Math.max(0, ratio)))
  const marks: string[] = []
  for (let i = 1; i < ticks && ticks <= 40; i++) {
    const tx = Math.round((w * i) / ticks)
    if (tx > fillW + 3) marks.push(`<rect class="m" x="${x + tx}" y="${y + h / 2 - 2}" width="1.5" height="4" rx=".75" opacity=".6"/>`)
  }
  return `<defs><clipPath id="${id}-f"><rect x="${x}" y="${y}" width="${fillW}" height="${h}" rx="${h / 2}"/></clipPath>
<linearGradient id="${id}-g" x1="0" x2="1"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".5" stop-color="#fff" stop-opacity=".5"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient></defs>
<rect class="k" x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}"/>
${marks.join('')}
<rect x="${x}" y="${y}" width="${fillW}" height="${h}" rx="${h / 2}" fill="${color}"/>
${isWorking && fillW > 0 ? `<g clip-path="url(#${id}-f)"><rect class="shine" x="${x}" y="${y}" width="80" height="${h}" fill="url(#${id}-g)"/></g>` : ''}`
}

const BAND_H = 22

const bandSvg = (s: Summary, W: number, ticks: number): string => {
  const title = fitText(s.title, 13, Math.max(60, W * 0.35))
  const pct = `${Math.round(s.ratio * 100)}%`
  const labelW = textWidth(s.label, 12) + 10
  const barX = Math.round(18 + textWidth(title, 13) + 12)
  const barW = Math.max(40, Math.round(W - barX - labelW - 44))
  const color = s.isFinished ? DONE : ACCENT
  return svg(
    W,
    BAND_H,
    `<circle class="${s.isWorking ? 'live' : ''}" cx="6" cy="${BAND_H / 2}" r="4" fill="${color}"/>
<text class="t" x="18" y="${BAND_H / 2 + 4.5}" font-family="${FONT}" font-size="13" font-weight="600">${xml(title)}</text>
${barSvg('band', barX, (BAND_H - 10) / 2, barW, 10, s.ratio, color, s.isWorking, ticks)}
<text class="t" x="${barX + barW + 10}" y="${BAND_H / 2 + 4}" font-family="${FONT}" font-size="12" font-weight="600">${xml(s.label)}</text>
<text class="m" x="${W - 2}" y="${BAND_H / 2 + 4}" text-anchor="end" font-family="${FONT}" font-size="12" font-variant-numeric="tabular-nums">${pct}</text>`,
  )
}

const HEADER_H = 44

const headerSvg = (W: number, t: ReturnType<typeof totals>, running: number, count: number): string => {
  const gap = 6
  const tw = (W - gap * 3) / 4
  const tile = (i: number, k: string, v: string) =>
    `<rect class="tile" x="${i * (tw + gap)}" y="0" width="${tw}" height="40" rx="8"/>
<text class="s" x="${i * (tw + gap) + 9}" y="15" font-family="${FONT}" font-size="11">${k}</text>
<text class="t" x="${i * (tw + gap) + 9}" y="32" font-family="${FONT}" font-size="15" font-weight="600" font-variant-numeric="tabular-nums">${v}</text>`
  return svg(
    W,
    HEADER_H,
    tile(0, 'Agents', `${running ? running + ' / ' : ''}${count}`) +
      tile(1, 'Cost', '≈' + fmtCost(t.cost)) +
      tile(2, 'Tokens', fmtTokens(t.tokens)) +
      tile(3, 'Time', fmtTime(t.time)),
  )
}

const statusMark = (x: number, y: number, status: AgentStatus): string => {
  const c = STATUS_COLOR[status]
  if (status === 'running') return `<circle class="live" cx="${x}" cy="${y}" r="4" fill="${c}"/>`
  if (status === 'done') return `<path d="M${x - 5} ${y}l3.5 3.5 6.5-7" fill="none" stroke="${c}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`
  if (status === 'failed') return `<path d="M${x - 4} ${y - 4}l8 8M${x + 4} ${y - 4}l-8 8" stroke="${c}" stroke-width="1.8" stroke-linecap="round"/>`
  return `<rect x="${x - 4}" y="${y - 4}" width="8" height="8" rx="1.5" fill="${c}"/>`
}

const AGENT_H = 64

const agentSvg = (W: number, a: AgentRun, at: number, i: number): string => {
  const left = 22
  const textW = W - left - 70
  const progress = progressOf(a)
  const ctx = ctxPct(a)
  const meta = [a.type, modelName(a.model), a.effort].filter(Boolean).join('  ·  ')
  const steps = a.stepTotal ? `${a.stepDone ?? 0}/${a.stepTotal}${a.stepNote ? ' · ' + a.stepNote : ''}` : a.status === 'running' ? `${a.requests} request${a.requests === 1 ? "" : "s"}` : ''
  const stats = `ctx ${ctx}% · ${fmtTokens(a.contextTokens)}`
  const barW = W - left - 2
  return svg(
    W,
    AGENT_H,
    `${statusMark(8, 14, a.status)}
<text class="t" x="${left}" y="18" font-family="${FONT}" font-size="13" font-weight="600">${xml(fitText(a.description || a.type, 13, textW))}</text>
<text class="s" x="${W - 2}" y="18" text-anchor="end" font-family="${FONT}" font-size="12" font-variant-numeric="tabular-nums">${fmtTime(elapsed(a, at))}</text>
<text class="s" x="${left}" y="34" font-family="${FONT}" font-size="11">${xml(fitText(meta, 11, textW))}</text>
<text class="s" x="${W - 2}" y="34" text-anchor="end" font-family="${FONT}" font-size="11" font-variant-numeric="tabular-nums">≈${fmtCost(a.costUsd)}</text>
${barSvg(`a${i}`, left, 41, barW, 4, progress ?? ctx / 100, progress === null ? '#9a9a96' : STATUS_COLOR[a.status === 'running' ? 'running' : a.status], a.status === 'running' && progress !== null)}
<text class="t" x="${left}" y="58" font-family="${FONT}" font-size="11" font-variant-numeric="tabular-nums">${xml(fitText(steps, 11, Math.max(0, barW - textWidth(stats, 11) - 12)))}</text>
<text class="m" x="${W - 2}" y="58" text-anchor="end" font-family="${FONT}" font-size="11" font-variant-numeric="tabular-nums">${stats}</text>
<line class="ln" x1="0" y1="${AGENT_H - 0.5}" x2="${W}" y2="${AGENT_H - 0.5}"/>`,
  )
}

const PENDING_H = 28

const pendingSvg = (W: number, t: { n: number; title: string }): string =>
  svg(
    W,
    PENDING_H,
    `<circle cx="8" cy="14" r="5" fill="none" stroke="#9a9a96" stroke-width="1.4"/><path d="M8 11.5v2.8l1.8 1.2" fill="none" stroke="#9a9a96" stroke-width="1.4" stroke-linecap="round"/>
<text class="s" x="22" y="18" font-family="${FONT}" font-size="13">${xml(fitText(`${t.n}. ${t.title}`, 13, W - 24))}</text>
<line class="ln" x1="0" y1="${PENDING_H - 0.5}" x2="${W}" y2="${PENDING_H - 0.5}"/>`,
  )

// ---------------------------------------------------------------------------
// Panel open/close

async function openPane($: EngineInterface): Promise<void> {
  const at = await $.clock.now()
  await update($, now, () => at)
  await $.ui.open({ id: PANE, title: PANE_TITLE })
}

// Opens the panel, or closes it when it is up; true when it ends up open.
async function togglePane($: EngineInterface): Promise<boolean> {
  const isOpen = (await $.ui.panes()).some(p => p.id === PANE)
  if (isOpen) {
    await $.ui.close({ id: PANE })
    return false
  }
  await openPane($)
  return true
}

type AutoOpen = 'agents' | 'plan' | 'never'

// Opens the panel by itself: once per session for subagents, once per new plan.
async function autoOpen($: EngineInterface, mode: AutoOpen, reason: 'agent' | 'plan'): Promise<void> {
  if (mode === 'never' || (mode === 'plan' && reason === 'agent')) return
  const v = await read($, view)
  if (reason === 'agent' && v.hasAutoOpened) return
  await update($, view, prev => ({ ...prev, hasAutoOpened: true }))
  void $.ui.open({ id: PANE, title: PANE_TITLE })
}

export const register: Register = (on, options) => {
  const autoOpenMode: AutoOpen = options.autoOpen === 'plan' || options.autoOpen === 'never' ? options.autoOpen : 'agents'

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.tool.register({
      name: 'progress',
      description:
        'Report progress of a multi-step task to the progress bar above the prompt and the agents panel. ' +
        'Call it after presenting a plan (title, tasks, phase "work"), each time a task is finished (done), ' +
        'when switching phase or re-planning (tasks), and once at the end with finished: true. ' +
        'Fields left out keep their previous value. Main session only: a call from a subagent is ignored.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short name of the overall task, a few words.' },
          total: { type: 'integer', minimum: 0, description: 'Number of planned tasks; defaults to the length of tasks.' },
          done: { type: 'integer', minimum: 0, description: 'Number of tasks finished so far.' },
          phase: { type: 'string', enum: [...PHASES] },
          finished: { type: 'boolean', description: 'True once the whole task is complete.' },
          tasks: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Planned task titles in order. When a task is delegated, use its title verbatim as the Agent description so the panel can match the run to it.',
          },
        },
      },
    })
    await $.tool.register({
      name: 'step',
      description:
        'For subagents: report progress on your own task to the agents panel. ' +
        'When you start a task of several steps, call it with total (3-8 steps) and done: 0, then again with done ' +
        'and a few-word note as each step finishes. Cheap and silent: it only draws a progress bar.',
      inputSchema: {
        type: 'object',
        properties: {
          done: { type: 'integer', minimum: 0, description: 'Steps finished so far.' },
          total: { type: 'integer', minimum: 1, description: 'Steps planned; may change if the plan changes.' },
          note: { type: 'string', description: 'The step in progress, a few words.' },
        },
        required: ['done'],
      },
      // In every agent's tool list, not behind ToolSearch: a subagent does not go looking for it.
      isDeferred: false,
    })
    await $.command.register({
      name: 'agents-hud',
      description: 'Show or hide the agents panel (args: open, close, clear)',
    })

    // Ticks the running agents' clocks; quiet when nothing runs.
    $.clock.every(1000, () => {
      void (async () => {
        const list = await read($, agents)
        if (!list.some(a => a.status === 'running')) return
        const at = await $.clock.now()
        await update($, now, () => at)
      })()
    })
    return started
  })

  on('command.run', { command: 'agents-hud' }, async ($, e) => {
    const arg = (e.args ?? '').trim().toLowerCase()
    if (arg === 'open') {
      await openPane($)
      return { text: 'Agents panel opened.' }
    }
    if (arg === 'close') {
      await $.ui.close({ id: PANE })
      return { text: 'Agents panel closed.' }
    }
    if (arg === 'clear') {
      await update($, agents, list => list.filter(a => a.status === 'running'))
      await update($, plan, () => null)
      return { text: 'Cleared finished agents and the plan.' }
    }
    return { text: (await togglePane($)) ? 'Agents panel opened.' : 'Agents panel closed.' }
  })

  on('tool.call', { tool: PROGRESS_TOOL }, async ($, e) => {
    // The plan is the main session's: a subagent's call carries its agentId and changes nothing.
    if (e.agentId) return { result: 'ignored: only the main session reports the plan' }
    const input = e as unknown as ProgressInput
    const prev = await read($, plan)
    const isNew = isNewPlan(prev, input)
    const next = await update($, plan, p => mergePlan(p, input))
    if (isNew) await update($, view, v => ({ ...v, isBandHidden: false }))
    if (isNew && next && next.tasks.length) await autoOpen($, autoOpenMode, 'plan')
    const running = (await read($, agents)).filter(a => a.status === 'running').length
    return { result: `ok: ${planLabel(next ?? blankPlan(), running)}` }
  }).catch(() => ({ result: 'ok' }))

  // A subagent's own steps: the call runs in its loop, so agentId names it.
  on('tool.call', { tool: STEP_TOOL }, async ($, e) => {
    const input = e as unknown as { done?: unknown; total?: unknown; note?: unknown }
    const agentId = e.agentId
    if (!agentId) return { result: 'ignored: only subagents report steps' }
    let isMatched = false
    await update($, agents, list =>
      list.map(a => {
        if (a.agentId !== agentId) return a
        isMatched = true
        const total = int(input.total, a.stepTotal ?? 0, 50)
        const done = int(input.done, a.stepDone ?? 0, 50)
        const note = typeof input.note === 'string' && input.note.trim() ? clip(input.note.trim(), 60) : undefined
        return { ...a, stepTotal: total, stepDone: total ? Math.min(total, done) : done, stepNote: note }
      }),
    )
    return { result: isMatched ? 'ok' : 'ignored: no panel row for this agent' }
  }).catch(() => ({ result: 'ok' }))

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    if (started.deny !== undefined) return started

    const at = await $.clock.now()
    const list = await read($, agents)
    // A batch starts when a subagent starts with none running: the band counts from there.
    if (!list.some(a => a.status === 'running')) await update($, view, v => ({ ...v, batchStartedAt: at }))
    const run: AgentRun = {
      id: started.agentId ?? `${e.tool_use_id}:${at}`,
      agentId: started.agentId,
      type: e.subagentType,
      description: clip(e.description || e.subagentType, MAX_TITLE),
      model: started.model,
      status: 'running',
      startedAt: at,
      contextTokens: 0,
      tokens: 0,
      costUsd: 0,
      requests: 0,
    }
    await update($, agents, prev => [...prev.filter(a => a.id !== run.id), run].slice(-MAX_AGENTS))
    await update($, now, () => at)
    await autoOpen($, autoOpenMode, 'agent')
    return started
    // A failure here must never stop a subagent: replay or run the spawn as is.
  }).catch(($, e, next) => next(e))

  // Each model request of a subagent: live context, tokens and cost.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    const agentId = e.agentId
    const usage = result.usage
    if (!agentId || !usage) return result

    const model = usage.model || e.model
    await update($, agents, list =>
      list.map(
        (a): AgentRun =>
          a.agentId !== agentId
            ? a
            : {
                ...a,
                model,
                effort: typeof e.effort === 'string' ? e.effort : a.effort,
                status: 'running',
                endedAt: undefined,
                contextTokens: usageTokens(usage),
                tokens: a.tokens + usageTokens(usage),
                costUsd: a.costUsd + costOf(model, usage),
                requests: a.requests + 1,
              },
      ),
    )
    return result
  })

  // A subagent's run ends: done, failed or stopped.
  on('turn.complete', async ($, e, next) => {
    const agentId = e.agentId
    if (agentId) {
      const at = await $.clock.now()
      const status: AgentStatus = e.reason === 'answer' ? 'done' : e.reason === 'aborted' ? 'stopped' : 'failed'
      await update($, agents, list =>
        list.map((a): AgentRun => {
          if (a.agentId !== agentId) return a
          // A run whose requests went unseen still gets the turn's own sum.
          const fallback =
            a.requests === 0 && e.usage
              ? { model: e.usage.model || a.model, tokens: usageTokens(e.usage), costUsd: costOf(e.usage.model || a.model, e.usage) }
              : {}
          return { ...a, ...fallback, status, endedAt: at }
        }),
      )
      await update($, now, () => at)
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const list = await read($, agents)
    const p = await read($, plan)
    const v = await read($, view)
    const at = Math.max(await read($, now), ...list.map(a => a.startedAt), 0)

    const running = list.filter(a => a.status === 'running').reverse()
    const finished = list.filter(a => a.status !== 'running').reverse()
    const pending = pendingTasks(p, list)
    const t = totals(list, at)
    const isEmpty = list.length === 0 && pending.length === 0

    const toggleDone = (
      <Button
        key="toggle-done"
        label={`${v.isDoneHidden ? '▸' : '▾'} Finished · ${finished.length}`}
        plain
        onPress={() => update($, view, prev => ({ ...prev, isDoneHidden: !prev.isDoneHidden }))}
      />
    )
    const clearDone = (
      <Button
        key="clear-done"
        label="Clear finished"
        plain
        dimColor
        onPress={() => update($, agents, prev => prev.filter(a => a.status === 'running'))}
      />
    )
    const empty = <Text dimColor>No subagents yet. They show up here as soon as one starts.</Text>

    if (e.surface !== 'terminal' && 'Svg' in ui) {
      const { Svg } = ui
      const W = Math.max(260, Math.min(900, (e.props.bodyColumns || 40) * 8 - 8))
      const s = p ? summarize(p, list, { ...v, isBandHidden: false }) : null
      return (
        <Box flexDirection="column" gap={1}>
          <Svg source={headerSvg(W, t, running.length, list.length)} alt={`${list.length} agents, ≈${fmtCost(t.cost)}, ${fmtTokens(t.tokens)} tokens, ${fmtTime(t.time)}`} width={W} height={HEADER_H} />
          {s && <Svg source={bandSvg(s, W, p?.total ?? 0)} alt={`${s.title}: ${s.label}`} width={W} height={BAND_H} />}
          {isEmpty && empty}
          {running.length > 0 && <Text dimColor>Running · {running.length}</Text>}
          {running.map((a, i) => (
            <Svg key={a.id} source={agentSvg(W, a, at, i)} alt={`${a.description}: ${a.status}`} width={W} height={AGENT_H} />
          ))}
          {finished.length > 0 && (
            <Box flexDirection="row" gap={2}>
              {toggleDone}
              {clearDone}
            </Box>
          )}
          {!v.isDoneHidden &&
            finished.map((a, i) => (
              <Svg key={a.id} source={agentSvg(W, a, at, running.length + i)} alt={`${a.description}: ${a.status}`} width={W} height={AGENT_H} />
            ))}
          {pending.length > 0 && <Text dimColor>Planned · {pending.length}</Text>}
          {pending.map(task => (
            <Svg key={`plan-${task.n}`} source={pendingSvg(W, task)} alt={`${task.n}. ${task.title}: planned`} width={W} height={PENDING_H} />
          ))}
        </Box>
      )
    }

    // Terminal: the same content in text rows.
    const cols = Math.max(24, e.props.bodyColumns || 40)
    const barW = Math.max(6, Math.min(20, cols - 30))
    const row = (a: AgentRun) => {
      const progress = progressOf(a)
      const color = STATUS_COLOR[a.status]
      const steps = a.stepTotal ? `${a.stepDone ?? 0}/${a.stepTotal}${a.stepNote ? ' ' + a.stepNote : ''} · ` : ''
      return (
        <Box key={a.id} flexDirection="column" marginBottom={1}>
          <Text wrap="truncate-end">
            <Text color={color}>{STATUS_GLYPH[a.status]} </Text>
            <Text bold>{a.description || a.type}</Text>
            <Text dimColor> {fmtTime(elapsed(a, at))}</Text>
          </Text>
          <Text dimColor wrap="truncate-end">
            {'  '}
            {[a.type, modelName(a.model), a.effort].filter(Boolean).join(' · ')} · ≈{fmtCost(a.costUsd)}
          </Text>
          <Text wrap="truncate-end">
            {'  '}
            {progress === null ? <Text dimColor>{textBar(ctxPct(a) / 100, barW)}</Text> : <Text color={color}>{textBar(progress, barW)}</Text>}
            <Text dimColor>
              {' '}
              {steps}ctx {ctxPct(a)}% · {fmtTokens(a.contextTokens)}
            </Text>
          </Text>
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {p && (
          <Text wrap="truncate-end">
            <Text color={p.isFinished ? DONE : ACCENT}>● </Text>
            <Text bold>{p.title} </Text>
            <Text color={p.isFinished ? DONE : ACCENT}>{textBar(planRatio(p), barW)}</Text>
            <Text> {planLabel(p, running.length)}</Text>
          </Text>
        )}
        <Text dimColor>
          {running.length ? `${running.length} running / ` : ''}
          {list.length} agents · ≈{fmtCost(t.cost)} · {fmtTokens(t.tokens)} tokens · {fmtTime(t.time)}
        </Text>
        <Box flexDirection="column" marginTop={1}>
          {isEmpty && empty}
          {running.length > 0 && <Text dimColor>Running · {running.length}</Text>}
          {running.map(row)}
          {finished.length > 0 && (
            <Box flexDirection="row" gap={2}>
              {toggleDone}
              {clearDone}
            </Box>
          )}
          {!v.isDoneHidden && finished.map(row)}
          {pending.length > 0 && <Text dimColor>Planned · {pending.length}</Text>}
          {pending.map(task => (
            <Text key={`plan-${task.n}`} dimColor wrap="truncate-end">
              ◷ {task.n}. {task.title}
            </Text>
          ))}
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const p = await read($, plan)
    const list = await read($, agents)
    const v = await read($, view)
    const s = summarize(p, list, v)
    if (!s) return next(e)

    // Draw this row with other mods' bands beneath it. The engine's own
    // placeholder ({ type: 'engine' }) is never nested: the desktop drops a band that nests it.
    const drawn = await Promise.resolve(next(e)).catch(() => null)
    const below = drawn && typeof drawn === 'object' && (drawn as { type?: string }).type !== 'engine' ? drawn : null

    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const crew = (
      <Button key="agents-hud-open" label={`Agents ×${s.crew}`} plain onPress={() => void togglePane($)} />
    )
    // Hides the plan's row; a band for running subagents comes back on its own.
    const dismiss = (
      <Button
        key="agents-hud-dismiss"
        label="✕"
        plain
        role="dismiss"
        onPress={async () => {
          await update($, view, prev => ({ ...prev, isBandHidden: true }))
          if (p?.isFinished) await update($, plan, () => null)
        }}
      />
    )
    const percent = `${Math.round(s.ratio * 100)}%`

    // The terminal's table has no Svg, but test the surface too.
    if (e.surface !== 'terminal' && 'Svg' in ui) {
      const { Svg } = ui
      const width = Math.max(180, Math.min(1600, (e.props.bodyColumns || 100) * 8 - 130))
      const ticks = p && !v.isBandHidden ? p.total : 0
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" alignItems="center" gap={1}>
            <Svg source={bandSvg(s, width, ticks)} alt={`${s.title}: ${s.label}, ${percent}`} width={width} height={BAND_H} />
            {crew}
            {p && !v.isBandHidden && dismiss}
          </Box>
          {below}
        </Box>
      )
    }

    const cols = e.props.bodyColumns
    const titleW = Math.max(8, Math.min(28, s.title.length + 2, Math.floor(cols / 3)))
    const barW = Math.max(6, Math.min(30, cols - titleW - s.label.length - 30))
    const color = s.isFinished ? DONE : ACCENT
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Box width={titleW} flexShrink={0}>
            <Text wrap="truncate-end">
              <Text color={color}>● </Text>
              {s.title}
            </Text>
          </Box>
          <Text color={color}>{textBar(s.ratio, barW)}</Text>
          <Text bold>{s.label}</Text>
          <Text dimColor>{percent}</Text>
          {crew}
          {p && !v.isBandHidden && dismiss}
        </Box>
        {below}
      </Box>
    )
  })
}
