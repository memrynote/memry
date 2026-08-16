/**
 * jsdom has no layout: `scrollHeight` is always 0 and `scrollTop` is a plain
 * writable property, so a "render a page and assert the scroll position" test
 * would pass against the broken mechanism this hook replaces. These tests drive
 * the hook's decision logic against an explicitly stubbed scroller whose
 * clamping behaviour is modelled by hand.
 */

import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useTabScrollRestore } from './use-tab-scroll-restore'
import type { Tab } from '@/contexts/tabs/types'
import type { TabIdentity } from '@/contexts/tabs/tab-identity'

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  getTab: vi.fn(),
  identity: { current: null as TabIdentity | null }
}))

vi.mock('@/contexts/tabs', () => ({
  useTabActionsOptional: () => ({ dispatch: mocks.dispatch, getTab: mocks.getTab })
}))

vi.mock('@/contexts/tabs/tab-identity', () => ({
  useTabIdentity: () => mocks.identity.current
}))

// ---------------------------------------------------------------------------
// Controllable ResizeObserver
// ---------------------------------------------------------------------------

class TestResizeObserver {
  static instances: TestResizeObserver[] = []
  private readonly callback: ResizeObserverCallback
  targets: Element[] = []
  disconnected = false

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback
    TestResizeObserver.instances.push(this)
  }

  observe(target: Element): void {
    this.targets.push(target)
  }

  unobserve(): void {}

  disconnect(): void {
    this.disconnected = true
    this.targets = []
  }

  static fireAll(): void {
    for (const instance of TestResizeObserver.instances) {
      instance.callback([], instance as unknown as ResizeObserver)
    }
  }

  static get live(): TestResizeObserver[] {
    return TestResizeObserver.instances.filter((i) => !i.disconnected)
  }
}

// ---------------------------------------------------------------------------
// Scroller stub: `scrollTop` clamps to the currently reachable range, which is
// the only thing that makes "content has not loaded yet" observable in jsdom.
// `scrollHeight`/`clientHeight` are modelled too, because the scrollable range
// is how the hook tells a user scroll from a content collapse.
// ---------------------------------------------------------------------------

/** Fixed viewport height; only the content height moves in these tests. */
const VIEWPORT_HEIGHT = 400

function makeScroller(maxScroll: number): {
  element: HTMLElement
  setMaxScroll: (next: number) => void
  userScrollTo: (offset: number) => void
  collapseContentTo: (nextMax: number) => void
} {
  const element = document.createElement('div')
  element.append(document.createElement('div'))
  document.body.append(element)

  let offset = 0
  let max = maxScroll

  Object.defineProperty(element, 'scrollTop', {
    configurable: true,
    get: () => Math.min(offset, max),
    set: (next: number) => {
      offset = Math.max(0, Math.min(next, max))
    }
  })
  Object.defineProperty(element, 'clientHeight', {
    configurable: true,
    get: () => VIEWPORT_HEIGHT
  })
  Object.defineProperty(element, 'scrollHeight', {
    configurable: true,
    get: () => max + VIEWPORT_HEIGHT
  })

  return {
    element,
    setMaxScroll: (next) => {
      max = next
    },
    userScrollTo: (next) => {
      offset = Math.max(0, Math.min(next, max))
      element.dispatchEvent(new Event('scroll'))
    },
    /**
     * What a page body remounting under a surviving scroller does: the content
     * height collapses, the browser clamps `scrollTop` into the new range and
     * emits a scroll event carrying the clamped value.
     */
    collapseContentTo: (nextMax) => {
      const previous = Math.min(offset, max)
      max = nextMax
      offset = Math.max(0, Math.min(offset, nextMax))
      if (offset !== previous) element.dispatchEvent(new Event('scroll'))
    }
  }
}

function tabWith(scrollState: Tab['scrollState']): Tab {
  return { id: 'tab-a', scrollState } as Tab
}

function savedPayloads(): Array<{ tabId: string; offset: number; entityId?: string }> {
  return mocks.dispatch.mock.calls
    .map(([action]) => action as { type: string; payload: Record<string, unknown> })
    .filter((action) => action.type === 'SAVE_TAB_STATE' && 'scrollState' in action.payload)
    .map((action) => {
      const scrollState = action.payload.scrollState as { offset: number; entityId?: string }
      return {
        tabId: action.payload.tabId as string,
        offset: scrollState.offset,
        entityId: scrollState.entityId
      }
    })
}

function savedKeys(): Array<string | undefined> {
  return mocks.dispatch.mock.calls
    .map(([action]) => action as { type: string; payload: Record<string, unknown> })
    .filter((action) => action.type === 'SAVE_TAB_STATE' && 'scrollState' in action.payload)
    .map((action) => (action.payload.scrollState as { key?: string }).key)
}

/**
 * A virtualizer stub. `getTotalSize` is the estimate the list currently
 * believes; `scrollToOffset` goes through the same clamping the element does,
 * which is what a real virtualizer's `scrollToOffset` ends up doing.
 */
function makeVirtualizer(
  scroller: { element: HTMLElement },
  totalSize: number
): {
  virtualizer: { getTotalSize: () => number; scrollToOffset: (offset: number) => void }
  setTotalSize: (next: number) => void
  calls: number[]
} {
  let size = totalSize
  const calls: number[] = []
  return {
    virtualizer: {
      getTotalSize: () => size,
      scrollToOffset: (offset: number) => {
        calls.push(offset)
        scroller.element.scrollTop = offset
      }
    },
    setTotalSize: (next: number) => {
      size = next
    },
    calls
  }
}

describe('useTabScrollRestore', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mocks.dispatch.mockClear()
    mocks.getTab.mockReset()
    mocks.getTab.mockReturnValue(null)
    mocks.identity.current = { tabId: 'tab-a', groupId: 'group-1', entityId: 'note-1' }
    TestResizeObserver.instances = []
    vi.stubGlobal('ResizeObserver', TestResizeObserver)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  // -------------------------------------------------------------------------
  // Save path
  // -------------------------------------------------------------------------

  it('throttles saves instead of dispatching per scroll event', () => {
    const scroller = makeScroller(1000)
    renderHook(() => useTabScrollRestore({ getScrollElement: () => scroller.element }))

    scroller.userScrollTo(120)
    scroller.userScrollTo(250)
    expect(savedPayloads()).toEqual([])

    vi.advanceTimersByTime(500)

    expect(savedPayloads()).toEqual([{ tabId: 'tab-a', offset: 250, entityId: 'note-1' }])
  })

  it('saves the offset from the ref, not from the DOM, at teardown', () => {
    const scroller = makeScroller(1000)
    const { unmount } = renderHook(() =>
      useTabScrollRestore({ getScrollElement: () => scroller.element })
    )

    scroller.userScrollTo(250)
    // What the old mechanism saw: by cleanup time the container has been emptied
    // by the Suspense swap and the browser has clamped `scrollTop` to 0.
    scroller.setMaxScroll(0)
    expect(scroller.element.scrollTop).toBe(0)

    unmount()

    expect(savedPayloads()).toEqual([{ tabId: 'tab-a', offset: 250, entityId: 'note-1' }])
  })

  it('keeps the user offset when a content collapse clamps the scroller', () => {
    const scroller = makeScroller(1000)
    const { unmount } = renderHook(() =>
      useTabScrollRestore({ getScrollElement: () => scroller.element })
    )

    scroller.userScrollTo(250)
    // Switching to an already-cached note: the scroller survives, but the page
    // body remounts, its height collapses, and the browser clamps `scrollTop`
    // to 0 and fires a scroll event for it. That is not the user scrolling.
    scroller.collapseContentTo(0)

    unmount()

    expect(savedPayloads()).toEqual([{ tabId: 'tab-a', offset: 250, entityId: 'note-1' }])
  })

  it('does not commit a content-collapse clamp as the live offset', () => {
    const scroller = makeScroller(1000)
    renderHook(() => useTabScrollRestore({ getScrollElement: () => scroller.element }))

    scroller.userScrollTo(250)
    scroller.collapseContentTo(0)
    vi.advanceTimersByTime(500)

    // The throttled save that was already pending must still carry the user's
    // offset, not the value the clamp wrote over it.
    expect(savedPayloads()).toEqual([{ tabId: 'tab-a', offset: 250, entityId: 'note-1' }])
  })

  it('still saves a genuine user scroll back to the top', () => {
    const scroller = makeScroller(1000)
    renderHook(() => useTabScrollRestore({ getScrollElement: () => scroller.element }))

    scroller.userScrollTo(250)
    vi.advanceTimersByTime(500)
    // Range unchanged: this is the user, not a clamp.
    scroller.userScrollTo(0)
    vi.advanceTimersByTime(500)

    expect(savedPayloads()).toEqual([
      { tabId: 'tab-a', offset: 250, entityId: 'note-1' },
      { tabId: 'tab-a', offset: 0, entityId: 'note-1' }
    ])
  })

  it('does not re-dispatch an offset already in tab state', () => {
    const scroller = makeScroller(1000)
    renderHook(() => useTabScrollRestore({ getScrollElement: () => scroller.element }))

    scroller.userScrollTo(250)
    vi.advanceTimersByTime(500)
    // A scroll that ends where the last committed save already left it.
    scroller.userScrollTo(300)
    scroller.userScrollTo(250)
    vi.advanceTimersByTime(500)

    expect(savedPayloads()).toEqual([{ tabId: 'tab-a', offset: 250, entityId: 'note-1' }])
  })

  it('writes nothing at teardown for a tab that was never scrolled', () => {
    const scroller = makeScroller(1000)
    const { unmount } = renderHook(() =>
      useTabScrollRestore({ getScrollElement: () => scroller.element })
    )

    unmount()

    expect(mocks.dispatch).not.toHaveBeenCalled()
  })

  it('still writes at teardown when a previous record exists', () => {
    const scroller = makeScroller(1000)
    mocks.getTab.mockReturnValue(tabWith({ offset: 400, entityId: 'note-old' }))

    const { unmount } = renderHook(() =>
      useTabScrollRestore({ getScrollElement: () => scroller.element })
    )

    unmount()

    // The stale record has to be corrected, not left pointing at gone content.
    expect(savedPayloads()).toEqual([{ tabId: 'tab-a', offset: 0, entityId: 'note-1' }])
  })

  it('flushes under the previous tab identity when the tab changes', () => {
    const scroller = makeScroller(1000)
    const { rerender } = renderHook(() =>
      useTabScrollRestore({ getScrollElement: () => scroller.element })
    )

    scroller.userScrollTo(310)
    mocks.identity.current = { tabId: 'tab-b', groupId: 'group-1', entityId: 'note-2' }
    rerender()

    expect(savedPayloads()).toEqual([{ tabId: 'tab-a', offset: 310, entityId: 'note-1' }])
  })

  it('does nothing without a tab identity', () => {
    mocks.identity.current = null
    const scroller = makeScroller(1000)
    const { unmount } = renderHook(() =>
      useTabScrollRestore({ getScrollElement: () => scroller.element })
    )

    scroller.userScrollTo(120)
    vi.advanceTimersByTime(500)
    unmount()

    expect(mocks.dispatch).not.toHaveBeenCalled()
  })

  it('does nothing when disabled', () => {
    const scroller = makeScroller(1000)
    mocks.getTab.mockReturnValue(tabWith({ offset: 400, entityId: 'note-1' }))

    const { unmount } = renderHook(() =>
      useTabScrollRestore({ getScrollElement: () => scroller.element, enabled: false })
    )

    expect(scroller.element.scrollTop).toBe(0)
    unmount()
    expect(mocks.dispatch).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // Restore path
  // -------------------------------------------------------------------------

  it('restores a saved offset stamped with the current entity', () => {
    const scroller = makeScroller(1000)
    mocks.getTab.mockReturnValue(tabWith({ offset: 400, entityId: 'note-1' }))

    renderHook(() => useTabScrollRestore({ getScrollElement: () => scroller.element }))

    expect(scroller.element.scrollTop).toBe(400)
    // Target reached on the first pass — nothing left to observe.
    expect(TestResizeObserver.live).toHaveLength(0)
  })

  it('discards a record stamped with a different entity', () => {
    const scroller = makeScroller(1000)
    mocks.getTab.mockReturnValue(tabWith({ offset: 400, entityId: 'note-old' }))

    renderHook(() => useTabScrollRestore({ getScrollElement: () => scroller.element }))

    expect(scroller.element.scrollTop).toBe(0)
    expect(TestResizeObserver.live).toHaveLength(0)
  })

  it('restores an offset of 0 (0 is a value, not "absent")', () => {
    const scroller = makeScroller(1000)
    // A reused scroll container that still holds the previous view's offset.
    scroller.element.scrollTop = 300
    mocks.getTab.mockReturnValue(tabWith({ offset: 0, entityId: 'note-1' }))

    renderHook(() => useTabScrollRestore({ getScrollElement: () => scroller.element }))

    expect(scroller.element.scrollTop).toBe(0)
  })

  it('re-applies the target as async content grows the container', () => {
    // Content has not arrived: the write clamps to 0 on the first pass.
    const scroller = makeScroller(0)
    mocks.getTab.mockReturnValue(tabWith({ offset: 500, entityId: 'note-1' }))

    renderHook(() => useTabScrollRestore({ getScrollElement: () => scroller.element }))

    expect(scroller.element.scrollTop).toBe(0)
    expect(TestResizeObserver.live).toHaveLength(1)

    scroller.setMaxScroll(1000)
    TestResizeObserver.fireAll()

    expect(scroller.element.scrollTop).toBe(500)
    expect(TestResizeObserver.live).toHaveLength(0)
  })

  it('gives up once the content has settled short of the target', () => {
    const scroller = makeScroller(0)
    mocks.getTab.mockReturnValue(tabWith({ offset: 500, entityId: 'note-1' }))

    renderHook(() => useTabScrollRestore({ getScrollElement: () => scroller.element }))
    expect(TestResizeObserver.live).toHaveLength(1)

    // RESTORE_SETTLE_MS with no growth: the target is provably unreachable.
    vi.advanceTimersByTime(2000)
    expect(TestResizeObserver.live).toHaveLength(0)

    scroller.setMaxScroll(1000)
    TestResizeObserver.fireAll()

    expect(scroller.element.scrollTop).toBe(0)
  })

  it('keeps chasing a slow note well past a one-second deadline', () => {
    const scroller = makeScroller(0)
    mocks.getTab.mockReturnValue(tabWith({ offset: 500, entityId: 'note-1' }))

    renderHook(() => useTabScrollRestore({ getScrollElement: () => scroller.element }))

    // Lazy chunk + note fetch: nothing for well over a second.
    vi.advanceTimersByTime(1500)
    // Editor mounts and lays out in stages; each growth buys another window.
    scroller.setMaxScroll(120)
    TestResizeObserver.fireAll()
    vi.advanceTimersByTime(1500)
    scroller.setMaxScroll(1000)
    TestResizeObserver.fireAll()

    expect(scroller.element.scrollTop).toBe(500)
    expect(TestResizeObserver.live).toHaveLength(0)
  })

  it('stops at the hard cap even while content keeps growing', () => {
    const scroller = makeScroller(0)
    mocks.getTab.mockReturnValue(tabWith({ offset: 5000, entityId: 'note-1' }))

    renderHook(() => useTabScrollRestore({ getScrollElement: () => scroller.element }))

    // Growth every second keeps resetting the settle window; RESTORE_MAX_MS is
    // the only thing that can end this.
    for (let elapsed = 0; elapsed < 15000; elapsed += 1000) {
      scroller.setMaxScroll(10 + elapsed / 100)
      TestResizeObserver.fireAll()
      vi.advanceTimersByTime(1000)
    }

    expect(TestResizeObserver.live).toHaveLength(0)
    scroller.setMaxScroll(9000)
    TestResizeObserver.fireAll()
    // Frozen at the last clamp the abandoned restore produced (10 + 14000/100).
    expect(scroller.element.scrollTop).toBe(150)
  })

  it('persists the target, not the clamp, when a tab is left mid-restore', () => {
    // Content never arrives before the user switches away again.
    const scroller = makeScroller(0)
    mocks.getTab.mockReturnValue(tabWith({ offset: 500, entityId: 'note-1' }))

    const { unmount } = renderHook(() =>
      useTabScrollRestore({ getScrollElement: () => scroller.element })
    )
    expect(scroller.element.scrollTop).toBe(0)

    unmount()

    expect(savedPayloads()).toEqual([{ tabId: 'tab-a', offset: 500, entityId: 'note-1' }])
  })

  it('ignores typing while a restore is in flight', () => {
    const scroller = makeScroller(0)
    mocks.getTab.mockReturnValue(tabWith({ offset: 500, entityId: 'note-1' }))

    renderHook(() => useTabScrollRestore({ getScrollElement: () => scroller.element }))

    scroller.element.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }))
    scroller.setMaxScroll(1000)
    TestResizeObserver.fireAll()

    expect(scroller.element.scrollTop).toBe(500)
  })

  it('cancels re-application on a key that scrolls', () => {
    const scroller = makeScroller(0)
    mocks.getTab.mockReturnValue(tabWith({ offset: 500, entityId: 'note-1' }))

    renderHook(() => useTabScrollRestore({ getScrollElement: () => scroller.element }))

    scroller.element.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown' }))
    scroller.setMaxScroll(1000)
    TestResizeObserver.fireAll()

    expect(scroller.element.scrollTop).toBe(0)
  })

  it('cancels re-application once the user scrolls themselves', () => {
    const scroller = makeScroller(0)
    mocks.getTab.mockReturnValue(tabWith({ offset: 500, entityId: 'note-1' }))

    renderHook(() => useTabScrollRestore({ getScrollElement: () => scroller.element }))
    expect(scroller.element.scrollTop).toBe(0)

    // Content arrives and the user immediately scrolls somewhere else.
    scroller.setMaxScroll(1000)
    scroller.userScrollTo(120)
    TestResizeObserver.fireAll()

    expect(scroller.element.scrollTop).toBe(120)
  })

  it('cancels re-application on a wheel gesture before its scroll lands', () => {
    const scroller = makeScroller(0)
    mocks.getTab.mockReturnValue(tabWith({ offset: 500, entityId: 'note-1' }))

    renderHook(() => useTabScrollRestore({ getScrollElement: () => scroller.element }))

    scroller.element.dispatchEvent(new Event('wheel'))
    scroller.setMaxScroll(1000)
    TestResizeObserver.fireAll()

    expect(scroller.element.scrollTop).toBe(0)
  })

  // -------------------------------------------------------------------------
  // Per-scroller key: pages with several panes (Inbox's sub-views, the project
  // hub's tabs, folder view's per-type scrollers) share one tab record.
  // -------------------------------------------------------------------------

  it('stamps the scroller key into every save', () => {
    const scroller = makeScroller(1000)
    renderHook(() =>
      useTabScrollRestore({ getScrollElement: () => scroller.element, key: 'inbox-list' })
    )

    scroller.userScrollTo(250)
    vi.advanceTimersByTime(500)

    expect(savedKeys()).toEqual(['inbox-list'])
  })

  it('does not apply one pane offset to another pane', () => {
    const scroller = makeScroller(1000)
    mocks.getTab.mockReturnValue(tabWith({ offset: 400, entityId: 'note-1', key: 'inbox-list' }))

    renderHook(() =>
      useTabScrollRestore({ getScrollElement: () => scroller.element, key: 'inbox-insights' })
    )

    expect(scroller.element.scrollTop).toBe(0)
  })

  it('restores an offset saved by the same pane', () => {
    const scroller = makeScroller(1000)
    mocks.getTab.mockReturnValue(tabWith({ offset: 400, entityId: 'note-1', key: 'inbox-list' }))

    renderHook(() =>
      useTabScrollRestore({ getScrollElement: () => scroller.element, key: 'inbox-list' })
    )

    expect(scroller.element.scrollTop).toBe(400)
  })

  it('leaves another pane record alone when this pane was never scrolled', () => {
    const scroller = makeScroller(1000)
    mocks.getTab.mockReturnValue(tabWith({ offset: 400, entityId: 'note-1', key: 'inbox-list' }))

    const { unmount } = renderHook(() =>
      useTabScrollRestore({ getScrollElement: () => scroller.element, key: 'inbox-insights' })
    )
    unmount()

    // Merely opening the insights pane must not wipe the list pane's offset.
    expect(mocks.dispatch).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // Virtualized mode
  // -------------------------------------------------------------------------

  it('restores through the virtualizer rather than writing scrollTop', () => {
    const scroller = makeScroller(1000)
    const { virtualizer, calls } = makeVirtualizer(scroller, 1400)
    mocks.getTab.mockReturnValue(tabWith({ offset: 400, entityId: 'note-1' }))

    renderHook(() => useTabScrollRestore({ getScrollElement: () => scroller.element, virtualizer }))

    expect(calls).toEqual([400])
    expect(scroller.element.scrollTop).toBe(400)
  })

  it('keeps re-applying until the estimated total size stops moving', () => {
    const scroller = makeScroller(1000)
    const { virtualizer, setTotalSize, calls } = makeVirtualizer(scroller, 1400)
    mocks.getTab.mockReturnValue(tabWith({ offset: 400, entityId: 'note-1' }))

    renderHook(() => useTabScrollRestore({ getScrollElement: () => scroller.element, virtualizer }))

    // The write stuck, but the total size is still an estimate: the row now
    // under 400px is not the row the user left.
    expect(TestResizeObserver.live).toHaveLength(1)

    // Rows measure shorter than estimated — the offset has to be re-applied
    // against the new total, and shrinking counts as movement.
    setTotalSize(1150)
    TestResizeObserver.fireAll()
    expect(TestResizeObserver.live).toHaveLength(1)

    // Two consecutive reads agree: the list has measured.
    TestResizeObserver.fireAll()
    expect(TestResizeObserver.live).toHaveLength(0)
    expect(calls).toEqual([400, 400, 400])
  })

  it('gives up in virtualized mode once the list stops measuring short', () => {
    const scroller = makeScroller(0)
    const { virtualizer, setTotalSize } = makeVirtualizer(scroller, 0)
    mocks.getTab.mockReturnValue(tabWith({ offset: 400, entityId: 'note-1' }))

    renderHook(() => useTabScrollRestore({ getScrollElement: () => scroller.element, virtualizer }))

    vi.advanceTimersByTime(2000)
    expect(TestResizeObserver.live).toHaveLength(0)

    setTotalSize(2000)
    scroller.setMaxScroll(1600)
    TestResizeObserver.fireAll()

    expect(scroller.element.scrollTop).toBe(0)
  })

  it('cancels a virtualized restore once the user scrolls', () => {
    const scroller = makeScroller(1000)
    const { virtualizer, calls } = makeVirtualizer(scroller, 1400)
    mocks.getTab.mockReturnValue(tabWith({ offset: 400, entityId: 'note-1' }))

    renderHook(() => useTabScrollRestore({ getScrollElement: () => scroller.element, virtualizer }))
    expect(calls).toEqual([400])

    scroller.userScrollTo(120)
    TestResizeObserver.fireAll()

    expect(calls).toEqual([400])
    expect(scroller.element.scrollTop).toBe(120)
  })

  it('keeps re-applying while only our own programmatic writes are observed', () => {
    const scroller = makeScroller(200)
    mocks.getTab.mockReturnValue(tabWith({ offset: 500, entityId: 'note-1' }))

    renderHook(() => useTabScrollRestore({ getScrollElement: () => scroller.element }))

    // Partial restore: the write clamped to 200 and the browser echoes a scroll
    // event carrying that same value. That is ours, not the user's.
    expect(scroller.element.scrollTop).toBe(200)
    scroller.element.dispatchEvent(new Event('scroll'))

    scroller.setMaxScroll(1000)
    TestResizeObserver.fireAll()

    expect(scroller.element.scrollTop).toBe(500)
  })
})
