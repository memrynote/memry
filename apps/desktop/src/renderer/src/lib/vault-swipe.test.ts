import { describe, expect, it } from 'vitest'
import {
  INITIAL_SWIPE,
  VAULT_SWIPE,
  applyWheel,
  indicatorWindow,
  neighborIndex,
  reachedFullWidth,
  resolveRelease,
  swipeProgress,
  visualOffset,
  type SwipeContext,
  type SwipeState,
  type WheelSample
} from './vault-swipe'

const WIDTH = 250
const both: SwipeContext = { width: WIDTH, hasTarget: () => true }
const onlyNext: SwipeContext = { width: WIDTH, hasTarget: (sign) => sign === -1 }

function run(samples: WheelSample[], ctx: SwipeContext = both): SwipeState {
  return samples.reduce((state, sample) => applyWheel(state, sample, ctx), INITIAL_SWIPE)
}

/** Evenly spaced wheel events, `dx`/`dy` each, 16ms apart. */
function stream(count: number, dx: number, dy = 0, start = 0): WheelSample[] {
  return Array.from({ length: count }, (_, i) => ({ dx, dy, time: start + i * 16 }))
}

describe('applyWheel axis lock', () => {
  it('waits for the lock distance before picking an axis', () => {
    const state = run(stream(1, 4))
    expect(state.phase).toBe('deciding')
    expect(state.rawOffset).toBe(0)
  })

  it('tracks a horizontal swipe and carries the movement it decided on', () => {
    const state = run(stream(3, 4))
    expect(state.phase).toBe('tracking')
    // Fingers moving left (positive deltaX) pull the list toward the left edge.
    expect(state.rawOffset).toBe(-12)
  })

  it('leaves a mostly vertical scroll to the list', () => {
    const state = run(stream(3, 3, 4))
    expect(state.phase).toBe('ignoring')
  })

  it('ignores a diagonal that is not clearly horizontal', () => {
    // |dx| must exceed 1.5x |dy|; 6 vs 5 does not.
    const state = run([
      { dx: 6, dy: 5, time: 0 },
      { dx: 6, dy: 5, time: 16 }
    ])
    expect(state.phase).toBe('ignoring')
  })

  it('stays ignoring for the rest of the gesture', () => {
    const state = run([...stream(3, 0, 10), ...stream(5, 20, 0, 48)])
    expect(state.phase).toBe('ignoring')
    expect(state.rawOffset).toBe(0)
  })
})

describe('offsets', () => {
  it('clamps travel to the pane width', () => {
    const state = run(stream(40, 20))
    expect(state.rawOffset).toBe(-WIDTH)
    expect(reachedFullWidth(state, both)).toBe(true)
  })

  it('resists past the last vault', () => {
    const state = run(stream(5, -10))
    expect(state.rawOffset).toBe(50)
    expect(visualOffset(state, onlyNext)).toBeCloseTo(50 * VAULT_SWIPE.rubberBand)
    expect(swipeProgress(state, onlyNext)).toBe(0)
    expect(reachedFullWidth(run(stream(40, -20)), onlyNext)).toBe(false)
  })

  it('reports progress toward a real neighbour', () => {
    const state = run(stream(5, 25))
    expect(swipeProgress(state, both)).toBeCloseTo(125 / WIDTH)
  })
})

describe('resolveRelease', () => {
  it('commits past the distance threshold', () => {
    const state = run(stream(10, 10))
    expect(Math.abs(state.rawOffset)).toBeGreaterThanOrEqual(VAULT_SWIPE.commitRatio * WIDTH)
    expect(resolveRelease(state, both)).toBe('commit')
  })

  it('cancels a slow, short drag', () => {
    // 5 events of 4px every 16ms: 0.25 px/ms, 20px of travel.
    const state = run(stream(5, 4))
    expect(resolveRelease(state, both)).toBe('cancel')
  })

  it('commits a short fast flick', () => {
    // 2 events of 20px 16ms apart: 1.25 px/ms, 40px of travel.
    const state = run(stream(2, 20))
    expect(Math.abs(state.rawOffset)).toBeLessThan(VAULT_SWIPE.commitRatio * WIDTH)
    expect(resolveRelease(state, both)).toBe('commit')
  })

  it('drops the flick when the fingers come back', () => {
    const state = run([...stream(2, 20), ...stream(3, -5, 0, 32)])
    expect(resolveRelease(state, both)).toBe('cancel')
  })

  it('cancels when there is no vault on that side', () => {
    const state = run(stream(20, -10))
    expect(resolveRelease(state, onlyNext)).toBe('cancel')
  })

  it('cancels anything that never tracked', () => {
    expect(resolveRelease(run(stream(3, 0, 10)), both)).toBe('cancel')
  })
})

describe('neighborIndex', () => {
  it('reveals the next vault when the list moves toward the left in LTR', () => {
    expect(neighborIndex(1, -1, false, 3)).toBe(2)
    expect(neighborIndex(1, 1, false, 3)).toBe(0)
  })

  it('mirrors in RTL', () => {
    expect(neighborIndex(1, -1, true, 3)).toBe(0)
    expect(neighborIndex(1, 1, true, 3)).toBe(2)
  })

  it('returns null past either end or without an active vault', () => {
    expect(neighborIndex(2, -1, false, 3)).toBeNull()
    expect(neighborIndex(0, 1, false, 3)).toBeNull()
    expect(neighborIndex(-1, -1, false, 3)).toBeNull()
  })
})

describe('indicatorWindow', () => {
  it('shows every vault up to five', () => {
    expect(indicatorWindow(5, 0)).toEqual({ start: 0, end: 5, moreBefore: false, moreAfter: false })
  })

  it('pins the window to the start for the first vaults', () => {
    expect(indicatorWindow(8, 0)).toEqual({ start: 0, end: 5, moreBefore: false, moreAfter: true })
  })

  it('centres the window on the active vault', () => {
    expect(indicatorWindow(8, 3)).toEqual({ start: 1, end: 6, moreBefore: true, moreAfter: true })
  })

  it('pins the window to the end for the last vaults', () => {
    expect(indicatorWindow(8, 7)).toEqual({ start: 3, end: 8, moreBefore: true, moreAfter: false })
  })
})
