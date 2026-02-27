import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SyncTimer } from './sync-timer'

describe('SyncTimer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('#given new timer #when no phases recorded', () => {
    it('#then finish returns zero phases and elapsed total', () => {
      const timer = new SyncTimer()
      vi.advanceTimersByTime(50)
      const result = timer.finish()

      expect(result.phases).toHaveLength(0)
      expect(result.totalMs).toBe(50)
    })
  })

  describe('#given timer #when single phase recorded', () => {
    it('#then finish includes phase with duration', () => {
      const timer = new SyncTimer()

      timer.startPhase('encrypt')
      vi.advanceTimersByTime(100)
      timer.endPhase()

      vi.advanceTimersByTime(10)
      const result = timer.finish()

      expect(result.phases).toHaveLength(1)
      expect(result.phases[0]).toEqual({ phase: 'encrypt', durationMs: 100 })
      expect(result.totalMs).toBe(110)
    })
  })

  describe('#given timer #when phase has itemCount', () => {
    it('#then phase entry includes itemCount', () => {
      const timer = new SyncTimer()

      timer.startPhase('network')
      vi.advanceTimersByTime(200)
      timer.endPhase(42)

      const result = timer.finish()

      expect(result.phases[0]).toEqual({ phase: 'network', durationMs: 200, itemCount: 42 })
    })
  })

  describe('#given timer #when multiple phases recorded', () => {
    it('#then all phases captured in order', () => {
      const timer = new SyncTimer()

      timer.startPhase('encrypt')
      vi.advanceTimersByTime(50)
      timer.endPhase(10)

      timer.startPhase('network')
      vi.advanceTimersByTime(150)
      timer.endPhase()

      timer.startPhase('apply')
      vi.advanceTimersByTime(30)
      timer.endPhase(10)

      const result = timer.finish()

      expect(result.phases).toHaveLength(3)
      expect(result.phases.map((p) => p.phase)).toEqual(['encrypt', 'network', 'apply'])
      expect(result.totalMs).toBe(230)
    })
  })

  describe('#given timer #when startPhase called without ending previous', () => {
    it('#then auto-closes previous phase', () => {
      const timer = new SyncTimer()

      timer.startPhase('encrypt')
      vi.advanceTimersByTime(100)
      timer.startPhase('network')
      vi.advanceTimersByTime(50)

      const result = timer.finish()

      expect(result.phases).toHaveLength(2)
      expect(result.phases[0]).toEqual({ phase: 'encrypt', durationMs: 100 })
      expect(result.phases[1]).toEqual({ phase: 'network', durationMs: 50 })
    })
  })

  describe('#given timer #when finish called with open phase', () => {
    it('#then auto-closes the open phase', () => {
      const timer = new SyncTimer()

      timer.startPhase('apply')
      vi.advanceTimersByTime(75)
      const result = timer.finish()

      expect(result.phases).toHaveLength(1)
      expect(result.phases[0]).toEqual({ phase: 'apply', durationMs: 75 })
    })
  })

  describe('#given timer #when endPhase called without active phase', () => {
    it('#then is a no-op', () => {
      const timer = new SyncTimer()
      timer.endPhase()
      const result = timer.finish()

      expect(result.phases).toHaveLength(0)
    })
  })
})
