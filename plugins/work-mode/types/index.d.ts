export type TempoMode = 'converge' | 'autonomous'

declare module 'claude-code' {
  interface PluginState {
    'work-mode': {
      tempo: TempoMode[]
      autoSent: boolean
      pending: string[]
    }
  }
}
