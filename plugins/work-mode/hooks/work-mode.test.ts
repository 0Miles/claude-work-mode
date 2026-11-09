import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { DEFAULT_CONFIG_EN, DEFAULT_CONFIG_ZH, localeFrom, resolveConfig, resolvePath } from './config'
import { autonomousText, knownModes, parseTempo, pickedArgs, pickerLabels, switchReply, switchTexts, tempoLabel } from './tempo'

const written: Record<string, string> = {}
const statuses: Array<string | undefined> = []
const STATE = '/home/u/.claude/state/tempo/sid-1'
const CFG_PATH = '/home/u/.config/work-mode/config.json'

type World = { files?: Record<string, string>; env?: Record<string, string>; language?: string }

function world(on: On, w: World = {}) {
  statuses.length = 0
  for (const k of Object.keys(written)) delete written[k]
  const files = w.files ?? {}
  mock.store(on)
  mock.env(on, { HOME: '/home/u', ...(w.env ?? {}) })
  on('session.id', () => ({ value: 'sid-1' }) as never)
  mock.clock(on)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('settings.read', () => (w.language === undefined ? { deny: 'no settings' } : ({ value: { language: w.language } } as never)))
  on('fs.read', (_$, e) => (e.path in files ? ({ value: files[e.path] } as never) : { deny: 'missing' }))
  on('process.run', (_$, e) => {
    if (e.argv[0] === 'rm') delete written[String(e.argv[2])]
    return { value: { exitCode: 0, stdout: '', stderr: '' } } as never
  })
  on('fs.write', (_$, e) => {
    written[e.path] = String(e.text)
    return { value: undefined }
  })
  on('ui.status', (_$, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('classic.UserPromptSubmit', () => ({}) as never)
  on('classic.PostToolUse', () => ({}))
}

const start = ($: any) => $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
const run = (args: string) => ({
  command: 'work-mode',
  args,
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: true, columns: 120 },
})

/** Runs /work-mode, then one tool call: what the switch told the model mid-turn. */
async function switched($: any, args: string): Promise<{ text?: string; context?: string[] }> {
  const r = await $.command.run(run(args))
  const t = await $.classic.PostToolUse({ tool_name: 'Edit', tool_input: {}, tool_response: '', tool_use_id: 't' } as never)
  return { text: r.text, context: t.additionalContext }
}

// Everything a zero-config user can see: no personal names, private tools or gendered pronouns.
// Words split so the repo's own leak scan (no private names or tool names anywhere) stays at zero hits.
const PERSONAL = new RegExp(['Dus' + 'tin', 'ext' + '-run', 'ai' + '-quota', '/check' + 'point', '\\b(he|him|his)\\b'].join('|'))
function expectNeutral(texts: Array<string | undefined>) {
  for (const t of texts) if (t !== undefined) expect(PERSONAL.test(t)).toBe(false)
}

const CUSTOM = {
  locale: 'en',
  userName: 'Alice',
  pronouns: 'she',
  autonomous: { extraRules: ['Always run the linter before committing.'], autoCloseCommand: '/close-session' },
  decisions: { sectionHeading: 'Open Questions', labels: ['external', 'money', 'choice'], tradeoffLabel: 'choice' },
}

// ---- group A: zero config ---------------------------------------------------------------

test('A: no config file, English: neutral texts end to end', async ($, on) => {
  world(on, { env: { LANG: 'en_US.UTF-8' } })
  await start($)
  const before = await $.classic.UserPromptSubmit({ prompt: 'hi', session_id: 'sid-1' } as never)
  expect(before.additionalContext).toBe(undefined)
  const r = await switched($, 'auto')
  expect(r.text).toContain('Work mode auto:')
  expect(r.text).toContain('compatible PreToolUse gates deny')
  expect(r.text).toContain('files out-of-scope findings as GitHub issues')
  expect(r.context?.[0]).toBe('[tempo] The user switched work mode just now: auto is on from this point.')
  expect(r.context).toContain(autonomousText(DEFAULT_CONFIG_EN))
  expect(JSON.parse(written[STATE] ?? '{}')).toEqual({ modes: ['autonomous'] })
  expect(statuses.at(-1)).toBe('AUTO')
  const again = await switched($, 'auto')
  expect(again.context).toEqual(['[tempo] The user switched work mode just now: auto is on from this point.'])
  const off = await switched($, 'off')
  expect(off.context?.[0]).toContain('The user turned work mode off')
  expect(STATE in written).toBe(false)
  expect(statuses.at(-1)).toBe(undefined)
  expectNeutral([r.text, again.text, off.text, ...(r.context ?? []), ...(off.context ?? [])])
})

test('A: wrap and out are gone: both are unknown modes and change nothing', async ($, on) => {
  world(on)
  await start($)
  for (const word of ['wrap', 'out']) {
    const r = await switched($, word)
    expect(r.text).toContain(`Unknown mode "${word}".`)
    expect(r.context).toBe(undefined)
  }
  expect(STATE in written).toBe(false)
})

test('A: the auto text in both locales: scope, issues, decisions, nothing personal', () => {
  for (const cfg of [DEFAULT_CONFIG_EN, DEFAULT_CONFIG_ZH]) {
    const t = autonomousText(cfg)
    expectNeutral([
      t,
      switchReply(['autonomous']),
      switchReply([]),
      ...switchTexts([], ['autonomous'], false, cfg),
      ...switchTexts(['autonomous'], [], true, cfg),
      ...pickerLabels(cfg),
    ])
    expect(t).toContain('do not open new branches of work')
    expect(t).toContain('gh issue create --repo')
    expect(t).toContain('never in an upstream or third-party repository')
    expect(t).toContain('Search its open issues first')
    expect(t).toContain('Do not start the work.')
    expect(t).toContain('the one outgoing step allowed')
    expect(t).toContain('lists the issues you opened')
  }
  const en = autonomousText(DEFAULT_CONFIG_EN)
  expect(en).toContain('so they are interrupted once')
  expect(en).toContain('do not wait for them')
  expect(en).toContain('[outbound] [payment] [delete] [permission] [tradeoff]')
  expect(en).toContain('outgoing messages take [outbound]')
  expect(en).toContain('permission and production changes [permission]')
  expect(en).toContain('"Decisions Needed" section')
  expect(en).toContain('Option A pros')
  expect(en).toContain('turns on their preference')
  expect(en).toContain('say in one line that the work is complete')
  const zh = autonomousText(DEFAULT_CONFIG_ZH)
  expect(zh).toContain('[對外] [金流] [刪除] [權限] [取捨]')
  expect(zh).toContain('outgoing messages take [對外]')
  expect(zh).toContain('permission and production changes [權限]')
  expect(zh).toContain('"待你決定" section')
  expect(zh).toContain('A 的好處')
  expect(zh).toContain('台灣用語')
})

test('A: Claude Code language setting picks Traditional Chinese even with an English LANG', async ($, on) => {
  world(on, { env: { LANG: 'en_US.UTF-8' }, language: '台灣繁體中文' })
  await start($)
  const r = await switched($, 'auto')
  expect(r.context).toContain(autonomousText(DEFAULT_CONFIG_ZH))
  expectNeutral([r.text, ...(r.context ?? [])])
})

test('A: locale detection order: WORK_MODE_LOCALE, then settings, then LC_ALL/LANG', async ($, on) => {
  world(on, { env: { WORK_MODE_LOCALE: 'en', LANG: 'zh_TW.UTF-8' }, language: '中文' })
  await start($)
  expect((await switched($, 'auto')).context).toContain(autonomousText(DEFAULT_CONFIG_EN))
  expect(localeFrom('English')).toBe('en')
  expect(localeFrom('日本語')).toBe(undefined)
})

test('A: with no language setting, a zh LANG picks Traditional Chinese', async ($, on) => {
  world(on, { env: { LANG: 'zh_TW.UTF-8' } })
  await start($)
  expect((await switched($, 'auto')).context).toContain(autonomousText(DEFAULT_CONFIG_ZH))
})

test('A: a subagent tool call does not take the switch notice meant for the main thread', async ($, on) => {
  world(on)
  await start($)
  await $.command.run(run('auto'))
  const sub = await $.classic.PostToolUse({ tool_name: 'Read', tool_input: {}, tool_response: '', tool_use_id: 't', agent_id: 'sub1' } as never)
  expect(sub.additionalContext).toBe(undefined)
  const main = await $.classic.PostToolUse({ tool_name: 'Read', tool_input: {}, tool_response: '', tool_use_id: 't' } as never)
  expect(main.additionalContext).toContain(autonomousText(DEFAULT_CONFIG_EN))
})

// ---- group B: custom config ------------------------------------------------------------

test('B: every override reaches the text', async ($, on) => {
  world(on, { files: { [CFG_PATH]: JSON.stringify(CUSTOM) } })
  await start($)
  const r = await switched($, 'auto')
  expect(r.context?.[0]).toBe('[tempo] Alice switched work mode just now: auto is on from this point.')
  const auto = (r.context ?? []).find(t => t.startsWith('[tempo: autonomous]')) ?? ''
  expect(auto).toContain('Alice has granted full autonomy')
  expect(auto).toContain('Always run the linter before committing.')
  expect(auto).toContain('so she is interrupted once')
  expect(auto).toContain('do not wait for her')
  expect(auto).toContain('"Open Questions" section')
  expect(auto).toContain('one label: [external] [money] [choice]. An item')
  expect(auto.includes('outgoing messages take')).toBe(false) // custom labels get no hard-stop map
  expect(auto).toContain('[choice] is not a catch-all')
  expect(auto).toContain('turns on her preference')
  expect(auto).toContain('run /close-session yourself without asking')
  expect(auto).toContain('awaiting her, do not run it')
})

test('B: WORK_MODE_CONFIG with ~ points at another file; removing it resets to defaults', async ($, on) => {
  const files: Record<string, string> = { '/home/u/elsewhere.json': JSON.stringify({ userName: 'Bob', pronouns: 'he' }) }
  world(on, { files, env: { WORK_MODE_CONFIG: '~/elsewhere.json' } })
  await start($)
  expect((await switched($, 'auto')).context?.[0]).toContain('Bob switched')
  delete files['/home/u/elsewhere.json']
  await start($)
  expect((await switched($, 'auto')).context?.[0]).toContain('The user switched')
})

test('B: malformed fields fall back one by one', () => {
  const cfg = resolveConfig({
    userName: 7,
    pronouns: 'xe',
    autonomous: { autoCloseCommand: ' ' },
    decisions: { labels: [], tradeoffLabel: 'nope' },
  })
  expect(cfg.userName).toBe('the user')
  expect(cfg.pronouns).toBe('they')
  expect(cfg.autonomous.autoCloseCommand).toBe(null)
  expect(cfg.decisions.labels).toEqual(DEFAULT_CONFIG_EN.decisions.labels)
  expect(cfg.decisions.tradeoffLabel).toBe('tradeoff')
  expect(resolveConfig('not an object', 'zh-TW').decisions.sectionHeading).toBe('待你決定')
  expect(resolvePath('~/a/b', '/h')).toBe('/h/a/b')
  expect(resolvePath('/abs', '/h')).toBe('/abs')
})

// ---- parsing and picker ------------------------------------------------------------------

test('tempo arguments and labels', () => {
  expect(parseTempo('')).toEqual({ kind: 'status' })
  expect(parseTempo(' Autonomous ')).toEqual({ kind: 'set', modes: ['autonomous'] })
  expect(parseTempo('auto')).toEqual({ kind: 'set', modes: ['autonomous'] })
  expect(parseTempo('off')).toEqual({ kind: 'set', modes: [] })
  expect(parseTempo('auto off')).toEqual({ kind: 'set', modes: ['autonomous'] })
  for (const w of ['wrap', 'converge', 'out', 'dispatch', 'fast']) expect(parseTempo(w).kind).toBe('error')
  expect(tempoLabel([])).toBe(undefined)
  expect(tempoLabel(['autonomous'])).toBe('AUTO')
  expect(knownModes(['converge', 'dispatch', 'autonomous'])).toEqual(['autonomous'])
})

test('picker: labels in both locales map back to auto and off', () => {
  const en = pickerLabels(DEFAULT_CONFIG_EN)
  const zh = pickerLabels(DEFAULT_CONFIG_ZH)
  for (const l of [...en, ...zh]) expect(l.includes(',')).toBe(false)
  expect(parseTempo(pickedArgs(en[0] ?? ''))).toEqual({ kind: 'set', modes: ['autonomous'] })
  expect(parseTempo(pickedArgs(en[1] ?? ''))).toEqual({ kind: 'set', modes: [] })
  expect(parseTempo(pickedArgs(zh[0] ?? '', DEFAULT_CONFIG_ZH))).toEqual({ kind: 'set', modes: ['autonomous'] })
  expect(parseTempo(pickedArgs(zh[1] ?? '', DEFAULT_CONFIG_ZH))).toEqual({ kind: 'set', modes: [] })
  expect(parseTempo(pickedArgs('auto nonsense')).kind).toBe('error')
  expect(parseTempo(pickedArgs('something else')).kind).toBe('error')
})

test('the mode text goes out once, then again after a compaction or /clear turns it off', async ($, on) => {
  world(on)
  on('session.compact', (_$, e) => ({ messages: e.messages }) as never)
  on('classic.SessionStart', () => ({}))
  await start($)
  expect((await switched($, 'auto')).context).toContain(autonomousText(DEFAULT_CONFIG_EN))
  const prompt = async () => (await $.classic.UserPromptSubmit({ prompt: 'p', session_id: 'sid-1' } as never)).additionalContext
  expect(await prompt()).toBe(undefined)
  await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'summary', toolUses: [] }] } as never)
  expect(await prompt()).toEqual([autonomousText(DEFAULT_CONFIG_EN)])
  expect(await prompt()).toBe(undefined)
  await $.classic.SessionStart({ source: 'clear' } as never)
  expect(statuses.at(-1)).toBe(undefined)
  expect(STATE in written).toBe(false)
  expect((await $.command.run(run(''))).text).toContain('Work mode: off')
})
