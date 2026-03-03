interface PhaseEntry {
  phase: string
  durationMs: number
  itemCount?: number
}

interface TimerResult {
  totalMs: number
  phases: PhaseEntry[]
}

export class SyncTimer {
  private startTime: number
  private currentPhase: string | null = null
  private phaseStart = 0
  private phases: PhaseEntry[] = []

  constructor() {
    this.startTime = Date.now()
  }

  startPhase(name: string): void {
    if (this.currentPhase) {
      this.endPhase()
    }
    this.currentPhase = name
    this.phaseStart = Date.now()
  }

  endPhase(itemCount?: number): void {
    if (!this.currentPhase) return
    const durationMs = Date.now() - this.phaseStart
    const entry: PhaseEntry = { phase: this.currentPhase, durationMs }
    if (itemCount !== undefined) entry.itemCount = itemCount
    this.phases.push(entry)
    this.currentPhase = null
  }

  finish(): TimerResult {
    if (this.currentPhase) {
      this.endPhase()
    }
    return {
      totalMs: Date.now() - this.startTime,
      phases: this.phases
    }
  }
}
