import { describe, it, expect } from 'vitest'
import { hitTestCard, shouldDeactivateForTool, nextActive, withActivePinned } from './canvas-active'
import type { CanvasCardRef } from './canvas-cards'

function card(over: Partial<CanvasCardRef> & { elementId: string }): CanvasCardRef {
  return {
    entityType: 'note',
    entityId: `e-${over.elementId}`,
    x: 0,
    y: 0,
    width: 100,
    height: 60,
    angle: 0,
    ...over
  }
}

describe('hitTestCard', () => {
  it('returns the card under an axis-aligned point', () => {
    const c = card({ elementId: 'a', x: 10, y: 10, width: 100, height: 60 })
    expect(hitTestCard([c], { x: 50, y: 40 })?.elementId).toBe('a')
    expect(hitTestCard([c], { x: 200, y: 40 })).toBeNull()
  })

  it('picks the topmost (last in z-order) when cards overlap', () => {
    const bottom = card({ elementId: 'bottom', x: 0, y: 0, width: 100, height: 100 })
    const top = card({ elementId: 'top', x: 0, y: 0, width: 100, height: 100 })
    expect(hitTestCard([bottom, top], { x: 50, y: 50 })?.elementId).toBe('top')
  })

  it('is angle-aware: a point inside the rotated rect hits; the pre-rotation corner misses', () => {
    // 100x60 centered at (50,30), rotated 90° (π/2). After rotation it spans
    // x∈[20,80], y∈[-20,80]. A point at (50,70) is inside the rotated card but
    // outside the unrotated AABB corner test near (95,5).
    const c = card({ elementId: 'r', x: 0, y: 0, width: 100, height: 60, angle: Math.PI / 2 })
    expect(hitTestCard([c], { x: 50, y: 70 })?.elementId).toBe('r')
    expect(hitTestCard([c], { x: 95, y: 5 })).toBeNull()
  })
})

describe('shouldDeactivateForTool', () => {
  it('stays active for the selection tool, deactivates for any drawing/hand tool', () => {
    expect(shouldDeactivateForTool('selection')).toBe(false)
    expect(shouldDeactivateForTool('freedraw')).toBe(true)
    expect(shouldDeactivateForTool('rectangle')).toBe(true)
    expect(shouldDeactivateForTool('hand')).toBe(true)
  })
})

describe('nextActive', () => {
  it('activates, deactivates, and clears only the matching card on cardGone', () => {
    expect(nextActive(null, { type: 'activate', id: 'x' })).toBe('x')
    expect(nextActive('x', { type: 'activate', id: 'y' })).toBe('y')
    expect(nextActive('x', { type: 'deactivate' })).toBeNull()
    expect(nextActive('x', { type: 'cardGone', id: 'x' })).toBeNull()
    expect(nextActive('x', { type: 'cardGone', id: 'other' })).toBe('x')
  })
})

describe('withActivePinned', () => {
  it('adds the active id to the visible set; no-op when null or already present', () => {
    expect([...withActivePinned(new Set(['a']), 'b')].sort()).toEqual(['a', 'b'])
    expect([...withActivePinned(new Set(['a']), null)]).toEqual(['a'])
    expect([...withActivePinned(new Set(['a']), 'a')]).toEqual(['a'])
  })
})
