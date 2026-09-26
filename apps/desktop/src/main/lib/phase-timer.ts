/**
 * Split a sequence of awaited steps into per-step durations for one log line.
 * `mark(name)` records the time since the previous mark (or the start).
 */
export interface PhaseTimer {
  mark: (name: string) => void
  summary: () => { totalMs: number; phases: Record<string, number> }
}

export function createPhaseTimer(): PhaseTimer {
  const startedAt = performance.now()
  let last = startedAt
  const phases: Record<string, number> = {}
  return {
    mark: (name) => {
      const now = performance.now()
      phases[name] = Math.round(now - last)
      last = now
    },
    summary: () => ({ totalMs: Math.round(performance.now() - startedAt), phases })
  }
}
