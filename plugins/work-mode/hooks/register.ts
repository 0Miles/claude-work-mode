import type { Register } from 'claude-code'

import { registerTempo, tempoClear, tempoContext, tempoResend, tempoStart } from './tempo'

// /work-mode (auto, wrap).
export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await tempoStart($)
    return next(e)
  })

  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    if (e.source === 'clear') await tempoClear($)
    else await tempoResend($)
    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    // precompute installs nothing, and a skipped compaction leaves the context as it was.
    if (!e.agentId && e.trigger !== 'precompute' && !(r && 'skip' in r && r.skip)) await tempoResend($)
    return r
  })

  on('classic.UserPromptSubmit', async ($, e, next) => {
    const r = await next(e)
    // A blocked prompt never reaches the model: keep every notice pending for the retry.
    if (e.agent_id || r.block || r.preventContinuation) return r
    const extra = await tempoContext($, e.session_id)
    return extra.length === 0 ? r : { ...r, additionalContext: [...(r.additionalContext ?? []), ...extra] }
  })

  registerTempo(on)
}
