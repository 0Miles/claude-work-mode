import type { EngineInterface } from 'claude-code'

// Everything personal lives in an optional JSON file, ~/.config/work-mode/config.json
// (or $WORK_MODE_CONFIG). Without it the mod runs on neutral English or Traditional
// Chinese defaults, picked from the Claude Code `language` setting and the locale env.

export type Locale = 'en' | 'zh-TW'
export type Pronouns = 'they' | 'he' | 'she'

export interface WorkModeConfig {
  locale: Locale
  /** How the mode text names the person driving the session. */
  userName: string
  pronouns: Pronouns
  autonomous: {
    /** Extra lines appended to the auto text, after the hard stops. */
    extraRules: string[]
    /** A command the model runs on its own once nothing is open, e.g. a session-closing skill; null for none. */
    autoCloseCommand: string | null
  }
  /** The decision list at the end of a reply; decision-label-guard.py reads the same section. */
  decisions: {
    sectionHeading: string
    /** The first four take the hard stops: outgoing, payment, delete, permission; the last is the tradeoff label. */
    labels: string[]
    tradeoffLabel: string
  }
}

export const DEFAULT_CONFIG_EN: WorkModeConfig = {
  locale: 'en',
  userName: 'the user',
  pronouns: 'they',
  autonomous: {
    extraRules: [],
    autoCloseCommand: null,
  },
  decisions: {
    sectionHeading: 'Decisions Needed',
    labels: ['outbound', 'payment', 'delete', 'permission', 'tradeoff'],
    tradeoffLabel: 'tradeoff',
  },
}

export const DEFAULT_CONFIG_ZH: WorkModeConfig = {
  ...DEFAULT_CONFIG_EN,
  locale: 'zh-TW',
  decisions: {
    sectionHeading: '待你決定',
    labels: ['對外', '金流', '刪除', '權限', '取捨'],
    tradeoffLabel: '取捨',
  },
}

let current: WorkModeConfig = DEFAULT_CONFIG_EN
let loaded = false
let home = ''

export function getConfig(): WorkModeConfig {
  return current
}

export function getHome(): string {
  return home
}

/** `~` and `~/x` become absolute; $.fs does not expand them. */
export function resolvePath(p: string, homeDir: string): string {
  if (p === '~') return homeDir
  if (p.startsWith('~/')) return `${homeDir}/${p.slice(2)}`
  return p
}

export function localeFrom(value: unknown): Locale | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  if (/zh|中文|繁體|台灣|臺灣|chinese/i.test(value)) return 'zh-TW'
  if (/^en|english/i.test(value)) return 'en'
  return undefined
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
const str = (v: unknown, d: string): string => (typeof v === 'string' && v.trim() !== '' ? v : d)
const strList = (v: unknown, d: string[]): string[] =>
  Array.isArray(v) && v.every(x => typeof x === 'string') ? (v as string[]) : d

/** Merges a parsed config file over the locale's defaults; anything malformed falls back field by field. */
export function resolveConfig(raw: unknown, fallbackLocale: Locale = 'en'): WorkModeConfig {
  const r = isObj(raw) ? raw : {}
  const locale = r.locale === 'en' || r.locale === 'zh-TW' ? r.locale : fallbackLocale
  const base = locale === 'zh-TW' ? DEFAULT_CONFIG_ZH : DEFAULT_CONFIG_EN
  const a = isObj(r.autonomous) ? r.autonomous : {}
  const d = isObj(r.decisions) ? r.decisions : {}
  const list = strList(d.labels, base.decisions.labels).filter(l => l.trim() !== '')
  const labels = list.length > 0 ? list : base.decisions.labels
  const tradeoff = str(d.tradeoffLabel, base.decisions.tradeoffLabel)
  return {
    locale,
    userName: str(r.userName, base.userName),
    pronouns: r.pronouns === 'he' || r.pronouns === 'she' || r.pronouns === 'they' ? r.pronouns : base.pronouns,
    autonomous: {
      extraRules: strList(a.extraRules, base.autonomous.extraRules),
      autoCloseCommand: typeof a.autoCloseCommand === 'string' && a.autoCloseCommand.trim() !== '' ? a.autoCloseCommand : null,
    },
    decisions: {
      sectionHeading: str(d.sectionHeading, base.decisions.sectionHeading),
      labels,
      tradeoffLabel: labels.includes(tradeoff) ? tradeoff : (labels.at(-1) ?? tradeoff),
    },
  }
}

async function detectLocale($: EngineInterface): Promise<Locale> {
  const explicit = localeFrom(await $.env.get('WORK_MODE_LOCALE'))
  if (explicit) return explicit
  try {
    const fromSettings = localeFrom(await $.settings.read({ key: 'language' }))
    if (fromSettings) return fromSettings
  } catch {
    // No settings access: fall through to the environment.
  }
  const env = (await $.env.get('LC_ALL')) ?? (await $.env.get('LANG')) ?? ''
  return /^zh/i.test(env) ? 'zh-TW' : 'en'
}

/** Reads the config file again; a missing or broken file resets to the defaults. */
export async function loadConfig($: EngineInterface): Promise<WorkModeConfig> {
  home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? ''
  const cfgEnv = await $.env.get('WORK_MODE_CONFIG')
  const path = resolvePath(cfgEnv && cfgEnv.trim() !== '' ? cfgEnv : '~/.config/work-mode/config.json', home)
  let raw: unknown = undefined
  try {
    raw = JSON.parse(await $.fs.read(path))
  } catch {
    raw = undefined
  }
  const fileLocale = isObj(raw) && (raw.locale === 'en' || raw.locale === 'zh-TW') ? raw.locale : undefined
  current = resolveConfig(raw, fileLocale ?? (await detectLocale($)))
  loaded = true
  return current
}

export async function ensureConfig($: EngineInterface): Promise<WorkModeConfig> {
  return loaded ? current : loadConfig($)
}
