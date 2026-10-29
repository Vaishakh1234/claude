import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const PLUGIN = 'agents-hud'
const PROGRESS = 'mcp__agents-hud__progress'
const STEP = 'mcp__agents-hud__step'

const band = { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 100, scroll: { offset: 0, bodyRows: 4 }, view: {} }
const pane = { title: '', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } as const

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

// The engine beneath the plugin: one subagent `a1` on Opus 5.5.
const engine = (on: On, opened: string[] = []) => {
  mock.clock(on)
  on('ui.open', (_$, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  // The engine's own drawing, under a band the plugin leaves alone.
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'a1' }))
  on('turn.complete', () => ({ text: '' }) as never)
  on('turn.step', async function* () {
    return {
      turnId: 'turn',
      index: 0,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn',
      usage: { model: 'claude-opus-5-5', input_tokens: 1e6, output_tokens: 1e6, cache_read_input_tokens: 2e6, cache_creation_input_tokens: 1e6 },
    } as never
  })
}

const spawn = ($: Engine, description: string) =>
  $.agent.spawn({
    tool_use_id: 't1',
    prompt: 'p',
    description,
    subagentType: 'Explore',
    provider: 'engine',
    parentModel: 'claude-opus-5-5',
    background: false,
    fork: false,
  } as never)

const request = async ($: Engine) => {
  const stream = ($.turn.step as (e: unknown) => AsyncIterable<unknown>)({ turnId: 'turn', index: 0, model: 'claude-opus-5-5', messageCount: 1, agentId: 'a1' })
  for await (const _ of stream) void _
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: the band and the panel follow a plan and its subagent`, async ($, on) => {
    const opened: string[] = []
    engine(on, opened)

    const reported = await $.tool.call({ tool: PROGRESS, title: 'Ship the thing', phase: 'work', tasks: ['Write the parser', 'Wire the CLI'] } as never)
    expect(reported).toMatchObject({ result: 'ok: Tasks 0/2' })
    // A new plan with tasks opens the panel by itself.
    expect(opened).toContain('agents-hud')

    const bar = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: band })
    expect((await bar.find({ key: 'agents-hud-open' }))?.props.label).toBe('Agents ×2')
    expect(await drawn(bar)).toContain('Ship the thing')

    await spawn($, 'Write the parser')
    await request($)
    // 1M in + 1M out + 2M cache read + 1M cache write on Opus 5.5: 4 + 20 + 0.4 + 8.
    expect(await $.tool.call({ tool: STEP, agentId: 'a1', done: 1, total: 3, note: 'reading files' } as never)).toMatchObject({ result: 'ok' })

    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: 'agents-hud', props: pane })
    const shown = await drawn(ui)
    expect(shown).toContain('Write the parser')
    expect(shown).toContain('≈$32.4')
    expect(shown).toContain('1/3')
    expect(shown).toContain('reading files')
    // The task that has not started yet is listed as planned.
    expect(shown).toContain('2. Wire the CLI')

    await ($.turn.complete as (e: unknown) => Promise<unknown>)({ agentId: 'a1', reason: 'answer', answer: 'ok' })
    expect(await $.tool.call({ tool: PROGRESS, done: 1 } as never)).toMatchObject({ result: 'ok: Tasks 1/2' })
    expect(await $.tool.call({ tool: PROGRESS, finished: true } as never)).toMatchObject({ result: 'ok: Done' })
  })

  test(`${surface}: a subagent without a plan shows a band while it runs`, async ($, on) => {
    engine(on)
    const bar = () => $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: band })

    expect(await (await bar()).find({ key: 'agents-hud-open' })).toBeUndefined()
    await spawn($, 'Find the config')
    expect(await drawn(await bar())).toContain('0/1 · 1 running')

    await ($.turn.complete as (e: unknown) => Promise<unknown>)({ agentId: 'a1', reason: 'answer', answer: 'ok' })
    expect(await (await bar()).find({ key: 'agents-hud-open' })).toBeUndefined()
  })

  // The schema is advice to the model: input outside it must still draw.
  test(`${surface}: input outside the tool's schema cannot break the drawing`, async ($, on) => {
    engine(on)
    const tasks = [{ title: 'Odd one' }, 42, null, ...Array.from({ length: 300 }, (_, i) => `Task ${i}`)]
    const reported = await $.tool.call({ tool: PROGRESS, title: 'Odd input', phase: 'nope', tasks, total: 1e9, done: -5 } as never)
    expect(reported).toMatchObject({ result: 'ok: Plan 0/100' })

    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: 'agents-hud', props: pane })
    const shown = await drawn(ui)
    expect(shown).toContain('Planned · 100')
    expect(shown).not.toContain('[object')
    expect(shown).not.toContain('NaN')
  })
}

test('a subagent cannot report the plan', async ($, on) => {
  engine(on)
  await $.tool.call({ tool: PROGRESS, title: 'Real plan', phase: 'work', total: 3, done: 1 } as never)
  const hijack = await $.tool.call({ tool: PROGRESS, agentId: 'a1', title: 'Hijacked', finished: true } as never)
  expect(hijack).toMatchObject({ result: 'ignored: only the main session reports the plan' })
  expect(await $.tool.call({ tool: PROGRESS, done: 2 } as never)).toMatchObject({ result: 'ok: Tasks 2/3' })
})

test('the main session cannot report steps', async ($, on) => {
  engine(on)
  expect(await $.tool.call({ tool: STEP, done: 1 } as never)).toMatchObject({ result: 'ignored: only subagents report steps' })
})
