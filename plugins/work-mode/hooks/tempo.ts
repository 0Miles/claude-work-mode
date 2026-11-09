import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import type { TempoMode } from '../types'
import { ensureConfig, getConfig, getHome, loadConfig } from './config'
import type { WorkModeConfig } from './config'

export { ensureConfig, getConfig, loadConfig, resolveConfig } from './config'
export type { WorkModeConfig } from './config'

// /work-mode: per-session working modes. State lives in $.state, so it never leaks to other sessions.
// Typed as short words: auto, wrap (long internal names still accepted).
// Any words, any order (`/work-mode wrap auto`); the result replaces the current modes.
// PreToolUse gates are shell hooks and cannot read $.state, so the modes are also written
// to ~/.claude/state/tempo/<session_id> (read by work-mode-gates' hooks/lib/tempo-auto.sh).
const modes = atom({ plugin: 'work-mode', key: 'tempo' } as const, [] as TempoMode[])
// Mode texts stay in context once sent, so each goes out once, and again on the next prompt only
// after a compaction or a (re)start may have dropped it.
const sent = atom({ plugin: 'work-mode', key: 'autoSent' } as const, false)
// What a /work-mode switch tells the model. A command's `context` does not reach the model
// (2.1.314), so it waits here for the next tool result (mid-turn) or the next prompt.
const pending = atom({ plugin: 'work-mode', key: 'pending' } as const, [] as string[])

// $.ui.status is one line per plugin. A host mod that joins several parts into one line swaps
// this sink for its own: it takes the work-mode label and returns the whole line to show
// (e.g. `setTempoStatusSink(t => putStatus('tempo', t))`). The engine does not let $ itself
// be handed to a function held in a variable, so the sink only ever sees text.
export type TempoStatusSink = (label: string | undefined) => string | undefined
let statusSink: TempoStatusSink = label => label
export function setTempoStatusSink(fn: TempoStatusSink): void {
  statusSink = fn
}

/** Hands over what the last switch left for the model, once (also mid-turn, from PostToolUse). */
export async function takePending($: EngineInterface): Promise<string[]> {
  const out = await read($, pending)
  if (out.length > 0) await update($, pending, () => [])
  return out
}

const ORDER: TempoMode[] = ['autonomous', 'converge']
export const SHORT: Record<TempoMode, string> = { autonomous: 'auto', converge: 'wrap' }

/** The modes this version knows, in display order. A session saved by an older version may still hold "dispatch". */
export function knownModes(list: readonly string[]): TempoMode[] {
  return ORDER.filter(m => list.includes(m))
}

async function readModes($: EngineInterface): Promise<TempoMode[]> {
  return knownModes(await read($, modes))
}

// ---- naming the person -----------------------------------------------------------------

type Words = { who: string; Who: string; subj: string; obj: string; poss: string; is: string }
export function words(cfg: WorkModeConfig): Words {
  const p = cfg.pronouns
  const subj = p === 'he' ? 'he' : p === 'she' ? 'she' : 'they'
  const obj = p === 'he' ? 'him' : p === 'she' ? 'her' : 'them'
  const poss = p === 'he' ? 'his' : p === 'she' ? 'her' : 'their'
  const who = cfg.userName
  return { who, Who: who.charAt(0).toUpperCase() + who.slice(1), subj, obj, poss, is: p === 'they' ? 'are' : 'is' }
}

const plain = (cfg: WorkModeConfig) => (cfg.locale === 'zh-TW' ? 'plain Traditional Chinese' : 'plain language')

// ---- mode texts --------------------------------------------------------------------------

export function convergeText(cfg: WorkModeConfig = getConfig()): string {
  const w = words(cfg)
  const c = cfg.converge
  const labels = c.decisionLabels.map(l => `[${l}]`).join(' ')
  const example = cfg.locale === 'zh-TW' ? '"A 的好處…；B 的好處…"' : '"Option A pros: ...; Option B pros: ..."'
  const reply =
    cfg.locale === 'zh-TW'
      ? 'written in plain Traditional Chinese (台灣用語, no jargon)'
      : 'written in plain language, no jargon'
  const close = c.autoCloseCommand
    ? `When nothing is open (all work done and verified, no background task, subagent or pane still running, no pending decision), run ${c.autoCloseCommand} yourself without asking. If anything is still running or awaiting the user, do not run it.`
    : 'When nothing is open (all work done and verified, no background task or subagent still running, no pending decision), say in one line that the work is complete and stop.'
  return [
    '[tempo: converge] Converge mode is ON for this session.',
    'Do not open new branches of work; finish what is already open.',
    `Decision items go in a "${c.sectionHeading}" section at the end of the reply.`,
    `Show a decision item only when it is new or its status changed, with your recommendation, ${reply}. Do not repost items already shown: end the reply with one line giving how many decisions are still open, and relist them in full only when asked or in the final report.`,
    `Start each decision item with one label: ${labels}. An item that fits none is yours to do now, not to ask (decision-label-guard blocks unlabeled items).`,
    `[${c.tradeoffLabel}] is not a catch-all: use it only when two paths are both reasonable and the choice turns on ${w.poss} preference, and state what each option gains (${example}). If you cannot name a preference-based reason for each side, do your recommendation now instead of asking.`,
    close,
  ].join('\n')
}

export function autonomousText(cfg: WorkModeConfig = getConfig()): string {
  const w = words(cfg)
  return [
    `[tempo: autonomous] ${w.Who} has granted full autonomy for this session (/work-mode auto).`,
    `Do not stop to ask about internal, reversible decisions: local files, git commits on local branches, worktrees, tests, and merges or deploys ${w.subj} already authorized. Decide, record the choice in your reply, and continue.`,
    `A process or quality gate that denies a call in this mode says how to proceed: follow that text and retry, do not wait for ${w.obj}.`,
    'Hard stops are never done on your own: outgoing messages (mail, chat, social posts), installing packages or cloning, anything touching credentials or secrets, deleting data that cannot be recovered, payments, permission changes, and production changes to config, rules or permissions or that delete production data. Put each one on a pending list and keep working on everything else.',
    ...cfg.autonomous.extraRules,
    `Even when ${w.subj} already approved one of them (e.g. "send it when done"), or any other call will raise a confirmation prompt (hook ask, built-in rm check), run it last: finish every other step first (uploads, file writes, doc updates, commits), then run all prompting calls back to back, so ${w.subj} ${w.is} interrupted once, not mid-work.`,
    `Report the pending list once, at the end of the work, each item with your recommendation, in ${plain(cfg)}.`,
  ].join('\n')
}

export function modeText(m: TempoMode, cfg: WorkModeConfig = getConfig()): string {
  return m === 'converge' ? convergeText(cfg) : autonomousText(cfg)
}

/** What the model reads the moment /work-mode switches: the new modes, and which ones stopped. */
export function switchTexts(
  prev: readonly TempoMode[],
  next: readonly TempoMode[],
  prevSent: boolean,
  cfg: WorkModeConfig = getConfig(),
): string[] {
  const w = words(cfg)
  const out: string[] = []
  const stopped = prev.filter(m => !next.includes(m))
  if (next.length === 0) {
    out.push(
      prev.length === 0
        ? '[tempo: off] Work mode is off (/work-mode off).'
        : `[tempo: off] ${w.Who} turned work mode off just now (/work-mode off): ${stopped.map(m => `[tempo: ${m}]`).join(' and ')} no longer applies. Back to normal behaviour from this point, including asking before steps the normal rules say to ask about.`,
    )
    return out
  }
  out.push(`[tempo] ${w.Who} switched work mode just now: ${next.map(m => SHORT[m]).join(' + ')} is on from this point.`)
  if (stopped.length > 0) out.push(`[tempo: off] ${stopped.map(m => `[tempo: ${m}]`).join(' and ')} no longer applies.`)
  for (const m of next) {
    if (prevSent && prev.includes(m)) continue
    out.push(modeText(m, cfg))
  }
  return out
}

export type TempoParse =
  | { kind: 'status' }
  | { kind: 'set'; modes: TempoMode[] }
  | { kind: 'error'; message: string }

/** Short words typed after /work-mode, mapped to the internal mode names the gate state file uses. */
const WORDS: Record<string, TempoMode> = {
  auto: 'autonomous', autonomous: 'autonomous',
  wrap: 'converge', converge: 'converge',
}

/** `/work-mode auto wrap`, `/work-mode wrap`, `/work-mode off`, or nothing for status. */
export function parseTempo(arg: string): TempoParse {
  const list = arg.toLowerCase().split(/[\s,+]+/).filter(Boolean)
  if (list.length === 0) return { kind: 'status' }
  const picked = new Set<TempoMode>()
  for (const w of list) {
    // off next to other words adds nothing: the words already replace the whole state.
    if (w === 'off') continue
    const mode = WORDS[w]
    if (!mode) return { kind: 'error', message: `Unknown mode "${w}".` }
    picked.add(mode)
  }
  return { kind: 'set', modes: ORDER.filter(m => picked.has(m)) }
}

// The picker shown by a bare /work-mode is a multi-select: tick any mix, it replaces the
// current modes. "off" shows only when something is on.
// Labels never hold a half-width comma: the answer comes back comma-joined.
export function pickerLabels(current: readonly TempoMode[], cfg: WorkModeConfig = getConfig()): string[] {
  const labels =
    cfg.locale === 'zh-TW'
      ? ['auto 自主（中途不問）', 'wrap 收斂（不開新方向）', 'off 關閉']
      : ['auto - autonomous (no mid-task questions)', 'wrap - converge (no new branches)', 'off - turn off']
  return current.length > 0 ? labels : labels.slice(0, 2)
}

/** A multi-select answer (comma-joined labels, or typed Other text) -> /work-mode words. */
export function pickedArgs(answer: string, cfg: WorkModeConfig = getConfig()): string {
  // Only an actual picker label (either language) is cut to its leading word; typed text stays whole
  // so parseTempo still rejects what it does not know ("auto nonsense" is an error, not "auto").
  const labels = new Set([
    ...pickerLabels(['autonomous'], { ...cfg, locale: 'en' }),
    ...pickerLabels(['autonomous'], { ...cfg, locale: 'zh-TW' }),
  ])
  return answer
    .split(',')
    .map(a => a.trim())
    .filter(Boolean)
    .map(a => (labels.has(a) ? (a.split(/\s+/)[0] ?? a) : a))
    .join(' ')
}

export function tempoLabel(m: readonly TempoMode[]): string | undefined {
  const parts = [m.includes('autonomous') ? 'AUTO' : '', m.includes('converge') ? 'WRAP' : ''].filter(Boolean)
  return parts.length ? parts.join(' + ') : undefined
}

async function refresh($: EngineInterface): Promise<void> {
  $.ui.status(statusSink(tempoLabel(await readModes($))))
}

// Gate hooks read this file by session id. No modes means no file: it is removed, never left stale.
async function writeState($: EngineInterface, sessionId: string, list: readonly TempoMode[]): Promise<void> {
  if (!sessionId) return
  try {
    const home = getHome() || (await $.env.get('HOME'))
    if (!home) return
    const path = `${home}/.claude/state/tempo/${sessionId}`
    if (list.length === 0) {
      const r = await $.process.run(['rm', '-f', path], { timeoutMs: 5000 })
      // If the file cannot be removed, an empty list is the same answer to the gates.
      if (r.exitCode !== 0) await $.fs.write(path, JSON.stringify({ modes: [] }) + '\n')
    } else {
      await $.fs.write(path, JSON.stringify({ modes: list }) + '\n')
    }
  } catch {
    // Without the file the gates keep asking, which is the safe direction.
  }
}

export async function tempoStart($: EngineInterface): Promise<void> {
  await loadConfig($)
  await $.command.register({
    name: 'work-mode',
    description: 'Work mode: auto (no questions) | wrap (converge) | off',
    argumentHint: '[auto] [wrap] | off',
    immediate: true,
  })
  await update($, sent, () => false)
  await refresh($)
  await writeState($, await $.session.id(), await readModes($))
}

/** /clear starts a fresh conversation: modes go off, and the status line is redrawn (session.start does not fire). */
export async function tempoClear($: EngineInterface): Promise<void> {
  await loadConfig($)
  await update($, modes, () => [])
  await update($, sent, () => false)
  await writeState($, await $.session.id(), [])
  await refresh($)
}

/** The summary or a resume may have dropped the mode texts: send them again with the next prompt. */
export async function tempoResend($: EngineInterface): Promise<void> {
  await loadConfig($)
  await update($, sent, () => false)
}

/** Context handed to the model with this prompt: the mode texts only when they are not in context yet. */
export async function tempoContext($: EngineInterface, sessionId: string): Promise<string[]> {
  await ensureConfig($)
  const list = await readModes($)
  await writeState($, sessionId, list)
  const queued = await takePending($)
  if (list.length === 0) return queued
  return [...queued, ...(await modeTexts($, list))]
}

async function modeTexts($: EngineInterface, list: readonly TempoMode[]): Promise<string[]> {
  if (await read($, sent)) return []
  await update($, sent, () => true)
  const cfg = getConfig()
  return list.map(m => modeText(m, cfg))
}

/** The reply /work-mode prints after a switch. */
export function switchReply(m: readonly TempoMode[]): string {
  if (m.length === 0) return 'Work mode off: back to normal.'
  if (m.length === 1 && m[0] === 'converge')
    return 'Work mode wrap: no new branches, replies show new decisions plus an open count. /work-mode off to stop.'
  return (
    `Work mode ${m.map(x => SHORT[x]).join(' + ')}: ` +
    (m.includes('autonomous')
      ? 'no mid-task questions on internal reversible steps; compatible PreToolUse gates deny with a how-to instead of asking; hard stops go to a pending list. '
      : '') +
    (m.includes('converge') ? 'No new branches; replies end with decisions plus recommendations. ' : '') +
    '/work-mode off to stop.'
  )
}

export function registerTempo(on: On): void {
  on('command.run', { command: 'work-mode' }, async ($, e) => {
    const cfg = await ensureConfig($)
    let parsed = parseTempo(e.args)
    if (parsed.kind === 'status') {
      try {
        const current = await readModes($)
        const label = tempoLabel(current) ?? 'off'
        const question =
          cfg.locale === 'zh-TW'
            ? `Work mode 目前：${label}。勾選要開的模式（可複選，會取代目前的設定）：`
            : `Work mode is now: ${label}. Tick the modes to turn on (any mix; it replaces the current set):`
        const answer = await $.ui.ask(question, {
          options: pickerLabels(current, cfg),
          header: 'Work mode',
          multiSelect: true,
        })
        parsed = parseTempo(pickedArgs(answer, cfg))
      } catch (err) {
        // Dismissed, or nobody to ask: fall through to the plain status line.
        $.ui.log(`tempo picker unavailable: ${String(err).slice(0, 300)}`, { to: 'debug' })
      }
    }
    const usage = 'Use /work-mode with auto, wrap or both (any order), or off.'
    if (parsed.kind === 'error') return { text: `${parsed.message} ${usage}` }
    if (parsed.kind === 'status') {
      const label = tempoLabel(await readModes($)) ?? 'off'
      return { text: `Work mode: ${label}. ${usage}` }
    }
    const prev = await readModes($)
    const prevSent = await read($, sent)
    await update($, pending, () => switchTexts(prev, parsed.modes, prevSent, cfg))
    await update($, modes, () => parsed.modes)
    await update($, sent, () => true)
    await writeState($, await $.session.id(), parsed.modes)
    await refresh($)
    return { text: switchReply(parsed.modes) }
  })

  // A switch made mid-turn reaches the model with the next tool result. Subagents keep their own context.
  on('classic.PostToolUse', async ($, e, next) => {
    const r = await next(e)
    if (e.agent_id) return r
    const extra = await takePending($)
    return extra.length === 0 ? r : { ...r, additionalContext: [...(r.additionalContext ?? []), ...extra] }
  })
}
