import { describe, it, expect } from 'vitest'
import { renderHook } from '@testing-library/react'
import {
  computeFiredAnchorIds,
  applyFiredState,
  watchFiredPills,
  useTriggeredDatePills
} from './use-triggered-date-pills'

function makePill(anchorId: string): HTMLElement {
  const el = document.createElement('span')
  el.className = 'date-mention'
  el.setAttribute('data-anchor-id', anchorId)
  return el
}

describe('computeFiredAnchorIds', () => {
  it('includes only rows with both triggeredAt and anchorId', () => {
    const ids = computeFiredAnchorIds([
      { anchorId: 'a1', triggeredAt: '2026-06-13T12:00:00Z' },
      { anchorId: 'a2', triggeredAt: null }, // pending — not fired
      { anchorId: null, triggeredAt: '2026-06-13T12:00:00Z' } // no anchor
    ])
    expect([...ids]).toEqual(['a1'])
  })

  it('returns an empty set when nothing has fired', () => {
    expect(computeFiredAnchorIds([]).size).toBe(0)
  })
})

describe('applyFiredState', () => {
  it('sets data-fired on fired pills and leaves others untouched', () => {
    const container = document.createElement('div')
    const p1 = makePill('a1')
    const p2 = makePill('a2')
    container.append(p1, p2)

    applyFiredState(container, new Set(['a1']))

    expect(p1.getAttribute('data-fired')).toBe('true')
    expect(p2.hasAttribute('data-fired')).toBe(false)
  })

  it('removes data-fired when an anchor is no longer fired', () => {
    const container = document.createElement('div')
    const p1 = makePill('a1')
    p1.setAttribute('data-fired', 'true')
    container.append(p1)

    applyFiredState(container, new Set())

    expect(p1.hasAttribute('data-fired')).toBe(false)
  })
})

describe('watchFiredPills', () => {
  it('re-applies fired state when a pill is added after setup', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const stop = watchFiredPills(container, () => new Set(['a1']))

    const p1 = makePill('a1')
    container.appendChild(p1)
    await new Promise((resolve) => setTimeout(resolve, 0)) // let the observer flush

    expect(p1.getAttribute('data-fired')).toBe('true')
    stop()
    container.remove()
  })

  it('stops re-applying after cleanup', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const stop = watchFiredPills(container, () => new Set(['a1']))
    stop()

    const p1 = makePill('a1')
    container.appendChild(p1)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(p1.hasAttribute('data-fired')).toBe(false)
    container.remove()
  })
})

describe('useTriggeredDatePills', () => {
  it('applies fired state on change and after pill DOM is recreated', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const containerRef = { current: container }
    const p1 = makePill('a1')
    container.appendChild(p1)

    const { rerender, unmount } = renderHook(
      ({ ids }) => useTriggeredDatePills(containerRef, ids),
      { initialProps: { ids: new Set<string>() } }
    )
    expect(p1.hasAttribute('data-fired')).toBe(false)

    rerender({ ids: new Set(['a1']) })
    expect(p1.getAttribute('data-fired')).toBe('true')

    // a recreated pill (same anchor) picks up fired state via the observer
    const p2 = makePill('a1')
    container.replaceChild(p2, p1)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(p2.getAttribute('data-fired')).toBe('true')

    unmount()
    container.remove()
  })
})
