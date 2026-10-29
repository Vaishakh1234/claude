import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const PLUGIN = 'mcp-hud'
const pane = { title: '', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } as const

// Everything a mounted drawing says: its texts, button labels and SVG sources.
type Found = { text?: string; props: Record<string, unknown> }
type Drawing = { findAll(query: { type: string }): Promise<readonly object[]> }

const drawn = async (ui: Drawing): Promise<string> => {
  const all = async (type: string) => (await ui.findAll({ type })) as readonly Found[]
  const texts = (await all('Text')).map(el => el.text ?? '')
  const buttons = (await all('Button')).map(el => String(el.props.label ?? ''))
  const svgs = (await all('Svg')).map(el => String(el.props.source))
  return [...texts, ...buttons, ...svgs].join('\n')
}

// The engine beneath the plugin: two servers in the context, one more tool in
// the tool list, and every tool call answered by `answer`.
const engine = (on: On, answer: () => unknown = () => ({ result: {} })) => {
  mock.clock(on)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('command.register', () => ({ value: { command: 'mcp-hud' } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: {
        window: 1_000_000,
        breakdown: {
          mcpTools: [
            { name: 'mcp__claude_ai_Gmail__create_draft', serverName: 'claude.ai Gmail', tokens: 900, isLoaded: true },
            { name: 'mcp__claude_ai_Gmail__search_threads', serverName: 'claude.ai Gmail', tokens: 700, isLoaded: false },
            { name: 'mcp__linear__create_issue', serverName: 'linear', tokens: 1200, isLoaded: true },
          ],
        },
      },
    } as never,
  }))
  on('tool.list', () => ({
    value: [
      { name: 'Bash', description: 'Runs a command.', mcp: false },
      { name: 'mcp__linear__list_teams', description: 'Lists teams.', mcp: true },
    ],
  }))
  on('tool.call', () => answer() as never)
}

const start = ($: Engine) => $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true } as never)

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: the sidebar lists servers, their tools and the calls made`, async ($, on) => {
    engine(on)
    await start($)
    await $.tool.call({ tool: 'mcp__claude_ai_Gmail__create_draft', to: 'team@example.com' } as never)
    await $.tool.call({ tool: 'Bash', command: 'ls' } as never)

    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: 'mcp-hud', props: pane })
    let shown = await drawn(ui)
    expect(shown).toContain('claude.ai Gmail')
    expect(shown).toContain('1 call')
    // The tool list's extra tool joins the context's server.
    expect(shown).toContain('▸ Show 2 tools')
    expect(shown).toContain('linear')
    expect(shown).not.toContain('Bash')

    await ui.press({ key: 'toggle-claude_ai_Gmail' })
    shown = await drawn(ui)
    expect(shown).toContain('create_draft')
    expect(shown).toContain('1×')
    expect(shown).toContain('search_threads')
  })

  test(`${surface}: Used shows only the servers called, search narrows the tools`, async ($, on) => {
    engine(on)
    await start($)
    await $.tool.call({ tool: 'mcp__linear__create_issue', title: 'Bug' } as never)

    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: 'mcp-hud', props: pane })
    await ui.press({ key: 'filter-used' })
    let shown = await drawn(ui)
    expect(shown).toContain('linear')
    expect(shown).not.toContain('claude.ai Gmail')

    await ui.press({ key: 'filter-all' })
    await ui.input({ key: 'search', text: 'search_thr', kind: 'change' })
    shown = await drawn(ui)
    expect(shown).toContain('search_threads')
    expect(shown).not.toContain('create_issue')
  })
}

test('a failed call is counted as failed', async ($, on) => {
  engine(on, () => ({ result: 'boom', isError: true }))
  await start($)
  await $.tool.call({ tool: 'mcp__linear__create_issue', title: 'Bug' } as never)

  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: 'mcp-hud', props: pane })
  expect(await drawn(ui)).toContain('1 call · 1 failed')
})

test('a server ToolSearch reports as failed is listed with its error', async ($, on) => {
  engine(on, () => ({
    result: { matches: [], query: 'x', total_deferred_tools: 0, failed_mcp_servers: [{ name: 'excalidraw-plus', error: 'HTTP 401' }] },
  }))
  await start($)
  await $.tool.call({ tool: 'ToolSearch', query: 'x', max_results: 5 } as never)

  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'Pane', requestId: 'mcp-hud', props: pane })
  const shown = await drawn(ui)
  expect(shown).toContain('excalidraw-plus')
  expect(shown).toContain('failed to connect · HTTP 401')
})

test('/mcp-hud refresh reports what it found', async ($, on) => {
  engine(on)
  await start($)
  const ran = await $.command.run({ command: 'mcp-hud', args: 'refresh' } as never)
  expect(ran).toMatchObject({ text: 'MCP: 2 servers connected, 4 tools, 0 calls so far.' })
})
