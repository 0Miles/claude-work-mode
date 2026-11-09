export type TempoMode = 'autonomous'

declare module 'claude-code' {
  interface PluginState {
    'work-mode': {
      tempo: TempoMode[]
      autoSent: boolean
      pending: string[]
    }
  }
}
