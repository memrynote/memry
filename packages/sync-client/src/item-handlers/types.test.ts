import { describe, expect, it } from 'vitest'
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
})
