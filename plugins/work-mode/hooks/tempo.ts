import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import type { TempoMode } from '../types'
import { DEFAULT_CONFIG_EN, DEFAULT_CONFIG_ZH, ensureConfig, getConfig, getHome, loadConfig } from './config'
import type { WorkModeConfig } from './config'

export { ensureConfig, getConfig, loadConfig, resolveConfig } from './config'
export type { WorkModeConfig } from './config'

// /work-mode auto | off: a per-session working mode. State lives in $.state, so it never leaks to other sessions.
// PreToolUse gates are shell hooks and cannot read $.state, so the mode is also written
// to ~/.claude/state/tempo/<session_id> (read by work-mode-gates' hooks/lib/tempo-auto.sh).
const modes = atom({ plugin: 'work-mode', key: 'tempo' } as const, [] as TempoMode[])
// The mode text stays in context once sent, so it goes out once, and again on the next prompt only
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

const ORDER: TempoMode[] = ['autonomous']
export const SHORT: Record<TempoMode, string> = { autonomous: 'auto' }

/** The modes this version has; anything else found in stored state is dropped. */
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

// ---- the auto text -----------------------------------------------------------------------

/** Which label each hard stop takes, when the labels are one of the default sets; custom labels get no map. */
function hardStopLabels(labels: readonly string[]): string | undefined {
  for (const base of [DEFAULT_CONFIG_EN, DEFAULT_CONFIG_ZH]) {
    const d = base.decisions.labels
    if (d.length !== labels.length || d.some((l, i) => l !== labels[i])) continue
    const [out, pay, del, perm] = d
    return `outgoing messages take [${out}], payments [${pay}], unrecoverable deletes [${del}], and installs, cloning, credentials, permission and production changes [${perm}]`
  }
  return undefined
}

export function autonomousText(cfg: WorkModeConfig = getConfig()): string {
  const w = words(cfg)
  const d = cfg.decisions
  const labels = d.labels.map(l => `[${l}]`).join(' ')
  const map = hardStopLabels(d.labels)
  const example = cfg.locale === 'zh-TW' ? '"A 的好處…；B 的好處…"' : '"Option A pros: ...; Option B pros: ..."'
  const reply =
    cfg.locale === 'zh-TW'
      ? 'written in plain Traditional Chinese (台灣用語, no jargon)'
      : 'written in plain language, no jargon'
  const closeCommand = cfg.autonomous.autoCloseCommand
  const close = closeCommand
    ? `When nothing is open (all work done and verified, no background task, subagent or pane still running, no pending decision), run ${closeCommand} yourself without asking. If anything is still running or awaiting ${w.obj}, do not run it.`
    : 'When nothing is open (all work done and verified, no background task or subagent still running, no pending decision), say in one line that the work is complete and stop.'
  return [
    `[tempo: autonomous] ${w.Who} has granted full autonomy for this session (/work-mode auto).`,
    `Do not stop to ask about internal, reversible decisions: local files, git commits on local branches, worktrees, tests, and merges or deploys ${w.subj} already authorized. Decide, record the choice in your reply, and continue.`,
    'Stay in scope: do not open new branches of work; finish what is already open.',
    'Out-of-scope work you notice on the way (a bug elsewhere, a refactor, a missing test) is not yours to do now and never goes on the decision list. Near the end of the work, open one GitHub issue for each finding in the repository the work belongs to (its origin remote: gh issue create --repo <owner>/<name>), never in an upstream or third-party repository. Search its open issues first and skip a finding already filed. Each issue gets a short title and says what you found, where (file and line), why it matters and a suggested fix, with no secrets or private data. Do not start the work. Without a GitHub remote, or when gh cannot create the issue, list the finding in the final report instead.',
    `A process or quality gate that denies a call in this mode says how to proceed: follow that text and retry, do not wait for ${w.obj}.`,
    'Hard stops are never done on your own: outgoing messages (mail, chat, social posts), installing packages or cloning, anything touching credentials or secrets, deleting data that cannot be recovered, payments, permission changes, and production changes to config, rules or permissions or that delete production data. Opening the issues above is the one outgoing step allowed. Put every hard stop on the decision list and keep working on everything else.',
    ...cfg.autonomous.extraRules,
    `Even when ${w.subj} already approved one of them (e.g. "send it when done"), or any other call will raise a confirmation prompt (hook ask, built-in rm check), run it last: finish every other step first (uploads, file writes, doc updates, commits), then run all prompting calls back to back, so ${w.subj} ${w.is} interrupted once, not mid-work.`,
    `Decision items go in a "${d.sectionHeading}" section at the end of the reply, each with your recommendation, ${reply}. Start each item with one label: ${labels}${map ? ` (${map})` : ''}. An item that fits none is yours to do now, not to ask (decision-label-guard blocks unlabeled items).`,
    `[${d.tradeoffLabel}] is not a catch-all: use it only when two paths are both reasonable and the choice turns on ${w.poss} preference, and state what each option gains (${example}). If you cannot name a preference-based reason for each side, do your recommendation now instead of asking.`,
    'Show a decision item only when it is new or its status changed. Do not repost items already shown: end the reply with one line giving how many decisions are still open, and relist them in full only when asked or in the final report. The final report also lists the issues you opened, with their links.',
    close,
  ].join('\n')
}

/** What the model reads the moment /work-mode switches: whether auto is on, and the text when it is not in context yet. */
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
  for (const m of next) {
    if (prevSent && prev.includes(m)) continue
    out.push(autonomousText(cfg))
  }
  return out
}

export type TempoParse =
  | { kind: 'status' }
  | { kind: 'set'; modes: TempoMode[] }
  | { kind: 'error'; message: string }

/** Words typed after /work-mode, mapped to the internal mode name the gate state file uses. */
const WORDS: Record<string, TempoMode> = { auto: 'autonomous', autonomous: 'autonomous' }

/** `/work-mode auto`, `/work-mode off`, or nothing for status. */
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

// The picker shown by a bare /work-mode. Labels never hold a half-width comma: answers come back comma-joined.
export function pickerLabels(cfg: WorkModeConfig = getConfig()): string[] {
  return cfg.locale === 'zh-TW'
    ? ['auto 自主（中途不問、不擴大範圍）', 'off 關閉']
    : ['auto - autonomous (no mid-task questions; stays in scope)', 'off - turn off']
}

/** A picker answer (a label, or typed Other text) -> /work-mode words. */
export function pickedArgs(answer: string, cfg: WorkModeConfig = getConfig()): string {
  // Only an actual picker label (either language) is cut to its leading word; typed text stays whole
  // so parseTempo still rejects what it does not know ("auto nonsense" is an error, not "auto").
  const labels = new Set([...pickerLabels({ ...cfg, locale: 'en' }), ...pickerLabels({ ...cfg, locale: 'zh-TW' })])
  return answer
    .split(',')
    .map(a => a.trim())
    .filter(Boolean)
    .map(a => (labels.has(a) ? (a.split(/\s+/)[0] ?? a) : a))
    .join(' ')
}

export function tempoLabel(m: readonly TempoMode[]): string | undefined {
  return m.includes('autonomous') ? 'AUTO' : undefined
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
    description: 'Work mode: auto (no questions, stays in scope) | off',
    argumentHint: 'auto | off',
    immediate: true,
  })
  await update($, sent, () => false)
  await refresh($)
  await writeState($, await $.session.id(), await readModes($))
}

/** /clear starts a fresh conversation: the mode goes off, and the status line is redrawn (session.start does not fire). */
export async function tempoClear($: EngineInterface): Promise<void> {
  await loadConfig($)
  await update($, modes, () => [])
  await update($, sent, () => false)
  await writeState($, await $.session.id(), [])
  await refresh($)
}

/** The summary or a resume may have dropped the mode text: send it again with the next prompt. */
export async function tempoResend($: EngineInterface): Promise<void> {
  await loadConfig($)
  await update($, sent, () => false)
}

/** Context handed to the model with this prompt: the mode text only when it is not in context yet. */
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
  return list.map(() => autonomousText(cfg))
}

/** The reply /work-mode prints after a switch. */
export function switchReply(m: readonly TempoMode[]): string {
  if (m.length === 0) return 'Work mode off: back to normal.'
  return 'Work mode auto: no mid-task questions on internal reversible steps; stays in scope and files out-of-scope findings as GitHub issues; compatible PreToolUse gates deny with a how-to instead of asking; hard stops go to the decision list. /work-mode off to stop.'
}

export function registerTempo(on: On): void {
  on('command.run', { command: 'work-mode' }, async ($, e) => {
    const cfg = await ensureConfig($)
    let parsed = parseTempo(e.args)
    if (parsed.kind === 'status') {
      try {
        const label = tempoLabel(await readModes($)) ?? 'off'
        const question =
          cfg.locale === 'zh-TW' ? `Work mode 目前：${label}。要切換成：` : `Work mode is now: ${label}. Switch to:`
        const answer = await $.ui.ask(question, {
          options: pickerLabels(cfg),
          header: 'Work mode',
          multiSelect: false,
        })
        parsed = parseTempo(pickedArgs(answer, cfg))
      } catch (err) {
        // Dismissed, or nobody to ask: fall through to the plain status line.
        $.ui.log(`tempo picker unavailable: ${String(err).slice(0, 300)}`, { to: 'debug' })
      }
    }
    const usage = 'Use /work-mode auto or /work-mode off.'
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
