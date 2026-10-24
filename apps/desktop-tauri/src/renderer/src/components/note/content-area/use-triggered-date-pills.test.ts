import { describe, it, expect, vi } from 'vitest'
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

/**
 * Counts the work a paint pass does: every pill it visits has its anchor id
 * read. Returns the pills that were visited since tracking started.
 */
function trackVisits(pills: HTMLElement[]): () => HTMLElement[] {
  const visited: HTMLElement[] = []
  for (const pill of pills) {
    const real = pill.getAttribute.bind(pill)
    vi.spyOn(pill, 'getAttribute').mockImplementation((name: string) => {
      if (name === 'data-anchor-id') visited.push(pill)
      return real(name)
    })
  }
  return () => visited
}

/** Let the MutationObserver deliver its records. */
function flushMutations(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
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

  it('scans no pills when a keystroke only rewrites a text node', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const paragraph = document.createElement('p')
    const pills = Array.from({ length: 50 }, (_, i) => makePill(`a${i}`))
    paragraph.append(...pills)
    paragraph.appendChild(document.createTextNode(''))
    container.appendChild(paragraph)

    const stop = watchFiredPills(container, () => new Set(['a0']))
    const visited = trackVisits(pills)

    // ProseMirror swaps the edited text node on every character.
    for (let i = 1; i <= 10; i++) {
      paragraph.replaceChild(document.createTextNode('x'.repeat(i)), paragraph.lastChild!)
      await flushMutations()
    }

    expect(visited()).toEqual([])
    stop()
    container.remove()
  })

  it('scans only the pill that was just created, not the whole note', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const paragraph = document.createElement('p')
    const pills = Array.from({ length: 50 }, (_, i) => makePill(`a${i}`))
    paragraph.append(...pills)
    container.appendChild(paragraph)

    const stop = watchFiredPills(container, () => new Set(['a0', 'fresh']))
    const visited = trackVisits(pills)

    const fresh = makePill('fresh')
    paragraph.appendChild(fresh)
    await flushMutations()

    expect(visited()).toEqual([])
    expect(fresh.getAttribute('data-fired')).toBe('true')
    stop()
    container.remove()
  })

  it('re-applies fired state to a pill nested inside a re-rendered block', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const stop = watchFiredPills(container, () => new Set(['a1']))

    const block = document.createElement('div')
    const pill = makePill('a1')
    block.appendChild(pill)
    container.appendChild(block)
    await flushMutations()

    expect(pill.getAttribute('data-fired')).toBe('true')
    stop()
    container.remove()
  })

  it('re-applies fired state when a pill swaps its anchor id in place', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const pill = makePill('a2')
    container.appendChild(pill)
    const stop = watchFiredPills(container, () => new Set(['a1']))

    pill.setAttribute('data-anchor-id', 'a1')
    await flushMutations()

    expect(pill.getAttribute('data-fired')).toBe('true')
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
