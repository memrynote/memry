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
// ---------------------------------------------------------------------------

function makeScroller(maxScroll: number): {
  element: HTMLElement
  setMaxScroll: (next: number) => void
  userScrollTo: (offset: number) => void
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

  return {
    element,
    setMaxScroll: (next) => {
      max = next
    },
    userScrollTo: (next) => {
      offset = Math.max(0, Math.min(next, max))
      element.dispatchEvent(new Event('scroll'))
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

  it('gives up re-applying after the restore timeout', () => {
    const scroller = makeScroller(0)
    mocks.getTab.mockReturnValue(tabWith({ offset: 500, entityId: 'note-1' }))

    renderHook(() => useTabScrollRestore({ getScrollElement: () => scroller.element }))
    expect(TestResizeObserver.live).toHaveLength(1)

    vi.advanceTimersByTime(1000)
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
