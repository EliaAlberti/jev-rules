// The rules pane: /rules shows every rule and map document of the project as a
// tree, green once Claude has been given it this session, flashing as it
// arrives, with Jev's latest score beside each one.
//
// Early access: Claude Code loads this module only with
// CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1. Without it the plugin's command hooks
// work exactly as before and this file is skipped.
//
// The pane decides nothing. It reads the session record the command hooks
// write, <tmpdir>/jev-rules/<session id>.json, and makes no Jev call.
import type { EngineInterface, Register } from 'claude-code'
import { fitRow, headline, newlyPicked, readRecord, scoreText, shouldAutoOpen, treeRows } from './lib/pane-model.mjs'

const PANE_ID = 'jev-rules'
const COMMAND = 'rules'
const TITLE = 'jev-rules'
const RULES_DIR = '.claude/jev-rules'
const MAP_DIR = '.claude/jev-map'
const MAX_DEPTH = 8
const POLL_MS = 700
const LIST_MS = 2000
const FRAME_MS = 250
const FLASH_MS = 3000
const GREEN = 'rgb(95,215,95)'

type Row = ReturnType<typeof treeRows>[number]
type Score = { p: number; via: string; file?: string }
type Viewport = { columns?: number; isFullscreen?: boolean }
type State = {
  started: boolean
  recordFile: string
  rows: Row[]
  picked: Set<string>
  scores: Record<string, Score>
  flashUntil: Map<string, number>
  now: number
  frame: number
  isOpen: boolean
  closedByPerson: boolean
  viewport: Viewport | undefined
  listedAt: number
  isPolling: boolean
}

async function listNames($: EngineInterface, dir: string, prefix: string, depth: number, out: string[]): Promise<void> {
  if (depth > MAX_DEPTH || !(await $.fs.exists(dir))) return
  for (const entry of await $.fs.list(dir)) {
    if (entry.name.startsWith('.')) continue
    const path = `${dir}/${entry.name}`
    if (entry.kind === 'dir' || (entry.isLink && !entry.name.endsWith('.md'))) {
      await listNames($, path, `${prefix}${entry.name}/`, depth + 1, out).catch(() => undefined)
    } else if (entry.name.endsWith('.md') && !(dir === MAP_DIR && entry.name === 'INDEX.md')) {
      out.push(`${prefix}${entry.name.slice(0, -3)}`)
    }
  }
}

async function loadRows($: EngineInterface): Promise<Row[]> {
  const rules: string[] = []
  const map: string[] = []
  await listNames($, RULES_DIR, '', 1, rules)
  await listNames($, MAP_DIR, '', 1, map)
  return treeRows([...rules.map(name => ({ kind: 'rule', name })), ...map.map(name => ({ kind: 'map', name }))])
}

async function recordPath($: EngineInterface): Promise<string> {
  const tmp = (await $.env.get('TMPDIR')) ?? (await $.env.get('TEMP')) ?? (await $.env.get('TMP')) ?? '/tmp'
  return `${tmp.replace(/[\\/]+$/, '')}/jev-rules/${await $.session.id()}.json`
}

async function poll($: EngineInterface, state: State, setting: string): Promise<void> {
  if (state.isPolling) return
  state.isPolling = true
  try {
    const now = await $.clock.now()
    let text: string | null = null
    if (await $.fs.exists(state.recordFile)) text = await $.fs.read(state.recordFile)
    const record = readRecord(text)
    const arrived = newlyPicked(state.picked, record.picked)
    const changed = arrived.length > 0 || record.picked.size !== state.picked.size || JSON.stringify(record.scores) !== JSON.stringify(state.scores)
    for (const key of arrived) state.flashUntil.set(key, now + FLASH_MS)
    state.picked = record.picked
    state.scores = record.scores
    if (state.isOpen && now - state.listedAt >= LIST_MS) {
      const rows = await loadRows($)
      state.listedAt = now
      if (JSON.stringify(rows) !== JSON.stringify(state.rows)) {
        state.rows = rows
        $.ui.invalidate('ui.render')
      }
    }
    if (arrived.length && shouldAutoOpen({ setting, viewport: state.viewport, closedByPerson: state.closedByPerson, isOpen: state.isOpen })) {
      await openPane($, state)
    }
    if (changed) $.ui.invalidate('ui.render')
  } catch (error) {
    $.ui.log(`jev-rules pane: ${String(error)}`)
  } finally {
    state.isPolling = false
  }
}

async function openPane($: EngineInterface, state: State): Promise<void> {
  state.rows = await loadRows($)
  state.listedAt = await $.clock.now()
  await $.ui.open({ id: PANE_ID, title: TITLE })
  state.isOpen = true
  $.ui.invalidate('ui.render')
}

async function start($: EngineInterface, state: State, setting: string): Promise<void> {
  if (state.started) return
  state.started = true
  state.recordFile = await recordPath($)
  $.clock.every(POLL_MS, () => { void poll($, state, setting) })
  $.clock.every(FRAME_MS, async () => {
    if (!state.flashUntil.size) return
    const now = await $.clock.now()
    for (const [key, until] of state.flashUntil) if (until <= now) state.flashUntil.delete(key)
    state.now = now
    state.frame += 1
    if (state.isOpen) $.ui.invalidate('ui.render')
  })
}

export const register: Register = (on, options) => {
  const setting = typeof options.pane_opens === 'string' ? options.pane_opens : 'on-first-pick'
  const state: State = {
    started: false, recordFile: '', rows: [], picked: new Set(), scores: {}, flashUntil: new Map(), now: 0, frame: 0,
    isOpen: false, closedByPerson: false, viewport: undefined, listedAt: 0, isPolling: false,
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: COMMAND, description: 'Show or hide the jev-rules pane: every rule, and the ones Jev picked', immediate: true })
    const result = await next(e)
    await start($, state, setting)
    return result
  })

  on('command.run', { command: COMMAND }, async ($) => {
    await start($, state, setting)
    if ((await $.ui.panes()).some(pane => pane.id === PANE_ID)) {
      await $.ui.close({ id: PANE_ID })
      return { text: 'Rules pane hidden' }
    }
    state.closedByPerson = false
    await poll($, state, setting)
    await openPane($, state)
    return { text: 'Rules pane shown' }
  })

  on('ui.close', async ($, e, next) => {
    if (e.id !== PANE_ID) return next(e)
    const result = await next(e)
    state.isOpen = false
    if (e.origin === 'person') state.closedByPerson = true
    return result
  })

  // The band above the prompt is drawn in every session; its viewport says
  // whether panes dock beside the transcript, which the pane needs to know
  // before it opens by itself. It changes nothing in the band.
  on('ui.render', { component: 'AbovePrompt' }, ($, e, next) => {
    if (e.viewport) state.viewport = { columns: e.viewport.columns, isFullscreen: e.viewport.isFullscreen }
    return next(e)
  })

  on('ui.render', { component: 'Pane' }, ($, e, next) => {
    if (e.requestId !== PANE_ID) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const columns = Math.max(20, e.props.bodyColumns ?? 40)
    if (!state.rows.some(r => !r.isFolder)) {
      return (
        <Box flexDirection="column">
          <Text bold>No rules yet</Text>
          <Text dimColor>{`Add Markdown files to ${RULES_DIR}/ and they appear here.`}</Text>
        </Box>
      )
    }
    return (
      <Box flexDirection="column">
        <Text bold>{headline(state.rows, state.picked)}</Text>
        <Text dimColor>green: given to Claude this session</Text>
        <Text>{' '}</Text>
        {state.rows.map(row => {
          if (row.isFolder) return <Text key={row.key} dimColor wrap="truncate-end">{`${'  '.repeat(row.depth)}${row.label}`}</Text>
          const isPicked = state.picked.has(row.key)
          const score = scoreText(state.scores[row.key])
          const line = fitRow({ depth: row.depth, label: row.label, mark: isPicked ? '✓' : '·', score, columns })
          const flashing = (state.flashUntil.get(row.key) ?? 0) > state.now && state.frame % 2 === 0
          if (flashing) return <Text key={row.key} bold color="black" backgroundColor={GREEN} wrap="truncate-end">{line}</Text>
          if (isPicked) return <Text key={row.key} bold color={GREEN} wrap="truncate-end">{line}</Text>
          return <Text key={row.key} dimColor wrap="truncate-end">{line}</Text>
        })}
      </Box>
    )
  })
}

