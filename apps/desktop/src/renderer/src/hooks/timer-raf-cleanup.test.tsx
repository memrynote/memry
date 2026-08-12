/**
 * Unmount cleanup for renderer timers and rAF handles (issue #1089).
 *
 * Every case arms a hook's delayed work, unmounts the owner, and then asserts
 * nothing is left pending. `vi.getTimerCount()` is the load-bearing assertion:
 * it counts handles the fake clock still owns, so it only reaches zero when the
 * hook really called `clearTimeout`. A leaked handle also keeps its callback's
 * closure — and everything that closure captured — alive until it fires, which
 * is the actual footprint cost these fixes remove.
 */

import { act, render, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'

import { useTrackedTimeout } from './use-tracked-timeout'
import { useRevealInSidebar } from './use-reveal-in-sidebar'
import { usePropertySection } from './use-property-section'
import { useUndoableAction } from './use-undoable-action'
import { useFocusTrap } from './use-focus-trap'
import { getAIConnections } from '@/services/ai-connections-service'

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() })
}))

vi.mock('@/hooks/use-properties', () => ({
  useProperties: () => ({
    properties: [],
    updateProperty: vi.fn().mockResolvedValue(undefined),
    addProperty: vi.fn().mockResolvedValue(undefined),
    removeProperty: vi.fn().mockResolvedValue(undefined),
    renameProperty: vi.fn().mockResolvedValue(undefined),
    reorderProperties: vi.fn().mockResolvedValue(undefined)
  })
}))

vi.mock('@/services/inbox-service', () => ({
  inboxService: {
    archive: vi.fn().mockResolvedValue({ success: true }),
    undoArchive: vi.fn().mockResolvedValue({ success: true }),
    undoFile: vi.fn().mockResolvedValue({ success: true })
  }
}))

describe('renderer timer/rAF cleanup on unmount', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  describe('useTrackedTimeout', () => {
    it('runs the callback and forgets the handle once it fires', () => {
      const spy = vi.fn()
      const { result } = renderHook(() => useTrackedTimeout())

      act(() => result.current(spy, 500))
      expect(vi.getTimerCount()).toBe(1)

      act(() => void vi.advanceTimersByTime(500))
      expect(spy).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(0)
    })

    it('cancels every pending callback when the owner unmounts', () => {
      const first = vi.fn()
      const second = vi.fn()
      const { result, unmount } = renderHook(() => useTrackedTimeout())

      act(() => {
        result.current(first, 500)
        result.current(second, 5000)
      })
      expect(vi.getTimerCount()).toBe(2)

      unmount()
      expect(vi.getTimerCount()).toBe(0)

      vi.advanceTimersByTime(10_000)
      expect(first).not.toHaveBeenCalled()
      expect(second).not.toHaveBeenCalled()
    })
  })

  it('useRevealInSidebar drops the 2s highlight auto-clear', () => {
    const { result, unmount } = renderHook(() => useRevealInSidebar([]))

    act(() => result.current.setHighlightedItemId('item-1'))
    expect(vi.getTimerCount()).toBe(1)

    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('usePropertySection drops the "newly added" highlight timer', async () => {
    const { result, unmount } = renderHook(() => usePropertySection({ entityId: 'note-1' }))

    await act(async () => {
      await result.current.handleAddProperty({ name: 'Status note', type: 'text' })
    })
    expect(vi.getTimerCount()).toBe(1)

    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('useUndoableAction drops every open 5s undo window', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } }
    })
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )
    const { result, unmount } = renderHook(() => useUndoableAction(), { wrapper })

    await act(async () => {
      await result.current.archiveWithUndo('item-1', 'First')
      await result.current.fileWithUndo('item-2', 'Second')
    })
    expect(vi.getTimerCount()).toBe(2)

    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('useFocusTrap cancels a queued auto-focus when the trap deactivates first', () => {
    const frames: Array<() => void> = []
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => frames.push(cb))
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      frames[id - 1] = () => {}
    })

    try {
      const Trap = ({ isActive }: { isActive: boolean }) => {
        const ref = useFocusTrap({ isActive, restoreFocus: false })
        return (
          <div ref={ref}>
            <button type="button">Inside</button>
          </div>
        )
      }

      const outside = document.createElement('button')
      document.body.append(outside)
      outside.focus()

      const { rerender, container } = render(<Trap isActive />)
      const inside = container.querySelector('button')!

      // Trap goes away inside the same frame the auto-focus was queued for.
      rerender(<Trap isActive={false} />)
      act(() => frames.forEach((frame) => frame()))

      expect(document.activeElement).not.toBe(inside)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('getAIConnections removes its abort listener once the delay resolves', async () => {
    const controller = new AbortController()
    const add = vi.spyOn(controller.signal, 'addEventListener')
    const remove = vi.spyOn(controller.signal, 'removeEventListener')

    const pending = getAIConnections('x'.repeat(500), controller.signal)
    expect(add).toHaveBeenCalledWith('abort', expect.any(Function), { once: true })

    await act(async () => {
      await vi.runAllTimersAsync()
      await pending
    })

    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
  })
})
