import { describe, expect, it, vi } from 'vitest'
import { resolveClockConflict } from './types'

describe('resolveClockConflict', () => {
  it('applies the remote wholesale when there is no local clock', () => {
    expect(resolveClockConflict(null, { a: 1 })).toEqual({
      action: 'apply',
      mergedClock: { a: 1 }
    })
  })

  it('skips a remote the local clock already dominates', () => {
    expect(resolveClockConflict({ a: 2 }, { a: 1 })).toEqual({
      action: 'skip',
      mergedClock: { a: 2 }
    })
  })

  it('merges concurrent clocks under their union', () => {
    expect(resolveClockConflict({ x: 2, y: 1 }, { x: 1, y: 2 })).toEqual({
      action: 'merge',
      mergedClock: { x: 2, y: 2 }
    })
  })

  /**
   * The second half of convergence after a field merge (#2180). Two devices
   * that merged the same concurrent pair both store the union clock while
   * holding different values; the first re-push is accepted and the second is
   * refused as a replay, so the refused device only converges because an
   * EQUAL incoming clock still applies the remote row rather than skipping it.
   */
  it('applies the remote wholesale on an equal clock, it does not skip', () => {
    expect(resolveClockConflict({ x: 2, y: 2 }, { x: 2, y: 2 })).toEqual({
      action: 'apply',
      mergedClock: { x: 2, y: 2 }
    })
  })

  // #2294: §6.5.2 P4 still holds when the payloads differ — the collision row
  // of the §6.5.2 trace, where the refused device converges only by applying
  // the accepted row under the same clock.
  it('applies an equal clock whose payload differs from the local one', () => {
    const identical = vi.fn(() => false)
    expect(resolveClockConflict({ X: 2, Y: 2 }, { X: 2, Y: 2 }, identical)).toEqual({
      action: 'apply',
      mergedClock: { X: 2, Y: 2 }
    })
    expect(identical).toHaveBeenCalledOnce()
  })

  // #2294: a device pulling back its own pushed row is the common case.
  it('skips an equal clock whose payload is identical to the local one', () => {
    expect(resolveClockConflict({ X: 2, Y: 2 }, { X: 2, Y: 2 }, () => true)).toEqual({
      action: 'skip',
      mergedClock: { X: 2, Y: 2 }
    })
  })

  // #2294: the payload comparison is paid only on an equal clock.
  it('never compares payloads for a non-equal clock', () => {
    const identical = vi.fn(() => true)
    expect(resolveClockConflict(null, { a: 1 }, identical).action).toBe('apply')
    expect(resolveClockConflict({ a: 1 }, { a: 2 }, identical).action).toBe('apply')
    expect(resolveClockConflict({ a: 2 }, { a: 1 }, identical).action).toBe('skip')
    expect(resolveClockConflict({ a: 1 }, { b: 1 }, identical).action).toBe('merge')
    expect(identical).not.toHaveBeenCalled()
  })
})
