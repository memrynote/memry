/**
 * useUndo Hook Tests (T694)
 * Tests for undo tracking, keyboard shortcuts, and action management.
 *
 * Note: The undo module uses global state which persists across tests.
 * Some tests verify behavior that builds on previous registrations.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useUndoTracker, useUndoKeyboardShortcut, createUndoableAction } from './use-undo'

// ============================================================================
// Mocks
// ============================================================================

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn()
  }
}))

import { toast } from 'sonner'

// ============================================================================
// useUndoTracker Tests
// ============================================================================

describe('useUndoTracker', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('registerUndo', () => {
    it('should register an undo action and return an ID', () => {
      const { result } = renderHook(() => useUndoTracker())
      const undoFn = vi.fn()

      let undoId: string = ''
      act(() => {
        undoId = result.current.registerUndo('Test action', undoFn)
      })

      expect(undoId).toBeTruthy()
      expect(undoId).toMatch(/^undo-/)
    })
  })

  describe('undo', () => {
    it('should execute the last registered undo function', () => {
      const { result } = renderHook(() => useUndoTracker())
      const undoFn = vi.fn()

      act(() => {
        result.current.registerUndo('Test action', undoFn)
      })

      act(() => {
        result.current.undo()
      })

      expect(undoFn).toHaveBeenCalledTimes(1)
    })

    it('should execute undo functions in LIFO order', () => {
      const { result } = renderHook(() => useUndoTracker())
      const callOrder: number[] = []

      const undoFn1 = vi.fn(() => callOrder.push(1))
      const undoFn2 = vi.fn(() => callOrder.push(2))
      const undoFn3 = vi.fn(() => callOrder.push(3))

      act(() => {
        result.current.registerUndo('Action 1', undoFn1)
        result.current.registerUndo('Action 2', undoFn2)
        result.current.registerUndo('Action 3', undoFn3)
      })

      act(() => {
        result.current.undo()
        result.current.undo()
        result.current.undo()
      })

      expect(callOrder).toEqual([3, 2, 1])
    })

    it('should show success toast on undo', () => {
      const { result } = renderHook(() => useUndoTracker())
      const undoFn = vi.fn()

      act(() => {
        result.current.registerUndo('Delete task', undoFn)
      })

      act(() => {
        result.current.undo()
      })

      expect(toast.success).toHaveBeenCalledWith('Undone: Delete task')
    })

    it('should return true on successful undo', () => {
      const { result } = renderHook(() => useUndoTracker())
      const undoFn = vi.fn()

      act(() => {
        result.current.registerUndo('Test', undoFn)
      })

      let success = false
      act(() => {
        success = result.current.undo()
      })

      expect(success).toBe(true)
    })

    it('should handle undo function errors gracefully', () => {
      const { result } = renderHook(() => useUndoTracker())
      const errorFn = vi.fn(() => {
        throw new Error('Undo failed')
      })

      act(() => {
        result.current.registerUndo('Failing action', errorFn)
      })

      let success = true
      act(() => {
        success = result.current.undo()
      })

      expect(success).toBe(false)
      expect(toast.error).toHaveBeenCalledWith('Failed to undo action')
    })
  })
})

// ============================================================================
// useUndoKeyboardShortcut Tests
// ============================================================================

describe('useUndoKeyboardShortcut', () => {
  let originalPlatform: string

  beforeEach(() => {
    originalPlatform = navigator.platform
    vi.clearAllMocks()
  })

  afterEach(() => {
    Object.defineProperty(navigator, 'platform', { value: originalPlatform, writable: true })
  })

  const mockPlatform = (platform: string) => {
    Object.defineProperty(navigator, 'platform', { value: platform, writable: true })
  }

  it('should add keydown event listener on mount', () => {
    const addEventListenerSpy = vi.spyOn(window, 'addEventListener')

    renderHook(() => useUndoKeyboardShortcut())

    expect(addEventListenerSpy).toHaveBeenCalledWith('keydown', expect.any(Function))
  })

  it('should remove keydown event listener on unmount', () => {
    const removeEventListenerSpy = vi.spyOn(window, 'removeEventListener')

    const { unmount } = renderHook(() => useUndoKeyboardShortcut())
    unmount()

    expect(removeEventListenerSpy).toHaveBeenCalledWith('keydown', expect.any(Function))
  })

  it('should respond to Cmd+Z on Mac', () => {
    mockPlatform('MacIntel')

    const { result: trackerResult } = renderHook(() => useUndoTracker())
    const undoFn = vi.fn()

    act(() => {
      trackerResult.current.registerUndo('Test action', undoFn)
    })

    renderHook(() => useUndoKeyboardShortcut())

    const event = new KeyboardEvent('keydown', {
      key: 'z',
      metaKey: true,
      ctrlKey: false,
      shiftKey: false,
      bubbles: true
    })
    const preventDefaultSpy = vi.spyOn(event, 'preventDefault')

    act(() => {
      window.dispatchEvent(event)
    })

    expect(preventDefaultSpy).toHaveBeenCalled()
    expect(undoFn).toHaveBeenCalled()
  })

  it('should respond to Ctrl+Z on Windows', () => {
    mockPlatform('Win32')

    const { result: trackerResult } = renderHook(() => useUndoTracker())
    const undoFn = vi.fn()

    act(() => {
      trackerResult.current.registerUndo('Test action', undoFn)
    })

    renderHook(() => useUndoKeyboardShortcut())

    const event = new KeyboardEvent('keydown', {
      key: 'z',
      metaKey: false,
      ctrlKey: true,
      shiftKey: false,
      bubbles: true
    })
    const preventDefaultSpy = vi.spyOn(event, 'preventDefault')

    act(() => {
      window.dispatchEvent(event)
    })

    expect(preventDefaultSpy).toHaveBeenCalled()
    expect(undoFn).toHaveBeenCalled()
  })

  it('should not intercept in input fields', () => {
    mockPlatform('MacIntel')

    const { result: trackerResult } = renderHook(() => useUndoTracker())
    const undoFn = vi.fn()

    act(() => {
      trackerResult.current.registerUndo('Test action', undoFn)
    })

    renderHook(() => useUndoKeyboardShortcut())

    // Create an input element as the target
    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()

    const event = new KeyboardEvent('keydown', {
      key: 'z',
      metaKey: true,
      bubbles: true
    })
    Object.defineProperty(event, 'target', { value: input })

    // The undo function for this test was registered after previous ones
    // So if it's not called, it means input field check worked
    const callCountBefore = undoFn.mock.calls.length

    act(() => {
      window.dispatchEvent(event)
    })

    // Undo should NOT be called for input fields (native undo should work)
    expect(undoFn.mock.calls.length).toBe(callCountBefore)

    document.body.removeChild(input)
  })

  it('should not intercept in textarea fields', () => {
    mockPlatform('MacIntel')

    const { result: trackerResult } = renderHook(() => useUndoTracker())
    const undoFn = vi.fn()

    act(() => {
      trackerResult.current.registerUndo('Test action', undoFn)
    })

    renderHook(() => useUndoKeyboardShortcut())

    const textarea = document.createElement('textarea')
    document.body.appendChild(textarea)

    const event = new KeyboardEvent('keydown', {
      key: 'z',
      metaKey: true,
      bubbles: true
    })
    Object.defineProperty(event, 'target', { value: textarea })

    const callCountBefore = undoFn.mock.calls.length

    act(() => {
      window.dispatchEvent(event)
    })

    expect(undoFn.mock.calls.length).toBe(callCountBefore)

    document.body.removeChild(textarea)
  })

  it('should not intercept in contentEditable elements', () => {
    mockPlatform('MacIntel')

    const { result: trackerResult } = renderHook(() => useUndoTracker())
    const undoFn = vi.fn()

    act(() => {
      trackerResult.current.registerUndo('Test action', undoFn)
    })

    renderHook(() => useUndoKeyboardShortcut())

    // Create a mock target with isContentEditable property
    const mockTarget = {
      tagName: 'DIV',
      isContentEditable: true
    }

    const event = new KeyboardEvent('keydown', {
      key: 'z',
      metaKey: true,
      bubbles: true
    })
    Object.defineProperty(event, 'target', { value: mockTarget })

    const callCountBefore = undoFn.mock.calls.length

    act(() => {
      window.dispatchEvent(event)
    })

    expect(undoFn.mock.calls.length).toBe(callCountBefore)
  })

  it('should ignore Cmd+Shift+Z (redo)', () => {
    mockPlatform('MacIntel')

    const { result: trackerResult } = renderHook(() => useUndoTracker())
    const undoFn = vi.fn()

    act(() => {
      trackerResult.current.registerUndo('Test action', undoFn)
    })

    renderHook(() => useUndoKeyboardShortcut())

    const event = new KeyboardEvent('keydown', {
      key: 'z',
      metaKey: true,
      shiftKey: true, // Redo, not undo
      bubbles: true
    })

    const callCountBefore = undoFn.mock.calls.length

    act(() => {
      window.dispatchEvent(event)
    })

    expect(undoFn.mock.calls.length).toBe(callCountBefore)
  })
})

// ============================================================================
// removeUndoEntry Tests
// ============================================================================

describe('removeUndoEntry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should remove a specific entry by ID', () => {
    const { result } = renderHook(() => useUndoTracker())
    const undoFn1 = vi.fn()
    const undoFn2 = vi.fn()

    let id1 = ''
    act(() => {
      id1 = result.current.registerUndo('Action 1', undoFn1)
      result.current.registerUndo('Action 2', undoFn2)
    })

    // #when — remove the first entry
    act(() => {
      result.current.removeUndoEntry(id1)
    })

    // #then — only undoFn2 remains; undoing should call it
    act(() => {
      result.current.undo()
    })
    expect(undoFn2).toHaveBeenCalledTimes(1)
    expect(undoFn1).not.toHaveBeenCalled()
  })

  it('should be a no-op for non-existent ID', () => {
    const { result } = renderHook(() => useUndoTracker())
    const undoFn = vi.fn()

    act(() => {
      result.current.registerUndo('Action', undoFn)
    })

    // #when — remove non-existent ID
    act(() => {
      result.current.removeUndoEntry('undo-does-not-exist')
    })

    // #then — original entry still works (verify by executing undo)
    act(() => {
      result.current.undo()
    })
    expect(undoFn).toHaveBeenCalledTimes(1)
  })

  it('should update canUndo when last entry is removed', () => {
    const { result } = renderHook(() => useUndoTracker())

    let id = ''
    act(() => {
      id = result.current.registerUndo('Only action', vi.fn())
    })

    act(() => {
      result.current.removeUndoEntry(id)
    })

    // #then — fresh hook read sees empty stack
    const { result: freshResult } = renderHook(() => useUndoTracker())
    expect(freshResult.current.canUndo).toBe(false)
  })
})

// ============================================================================
// createUndoableAction Tests
// ============================================================================

describe('createUndoableAction', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should execute the action and return result', () => {
    const action = vi.fn(() => 'result')
    const undoFn = vi.fn()

    const undoableAction = createUndoableAction('Test', action, undoFn)
    const result = undoableAction()

    expect(action).toHaveBeenCalled()
    expect(result).toBe('result')
  })

  it('should register undo after action execution', () => {
    const action = vi.fn()
    const undoFn = vi.fn()

    const undoableAction = createUndoableAction('Test', action, undoFn)
    undoableAction()

    // Verify undo was registered by checking if it can be executed
    const { result: trackerResult } = renderHook(() => useUndoTracker())

    expect(trackerResult.current.canUndo).toBe(true)
  })

  it('should work with typed return values', () => {
    interface Task {
      id: string
      title: string
    }

    const newTask: Task = { id: '1', title: 'Test task' }
    const action = vi.fn<[], Task>(() => newTask)
    const undoFn = vi.fn()

    const undoableAction = createUndoableAction<Task>('Create task', action, undoFn)
    const result = undoableAction()

    expect(result).toEqual(newTask)
  })
})

// ============================================================================
// Subscription / render-purity Tests
// ============================================================================

/** Matches UNDO_EXPIRY_MS in use-undo.ts */
const UNDO_EXPIRY_MS = 10_000

describe('useUndoTracker subscription', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // The undo stack is module-global and only resets when the last tracker
    // unmounts. Mount + unmount one to drain anything earlier tests left behind.
    renderHook(() => useUndoTracker()).unmount()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('flips canUndo on an already-mounted tracker when an action is registered', () => {
    const { result } = renderHook(() => useUndoTracker())
    expect(result.current.canUndo).toBe(false)

    act(() => {
      result.current.registerUndo('Delete task', vi.fn())
    })

    expect(result.current.canUndo).toBe(true)
    expect(result.current.lastActionDescription).toBe('Delete task')
  })

  it('notifies every mounted tracker, not just the one that registered', () => {
    const { result: a } = renderHook(() => useUndoTracker())
    const { result: b } = renderHook(() => useUndoTracker())

    act(() => {
      a.current.registerUndo('Archive project', vi.fn())
    })

    expect(b.current.canUndo).toBe(true)
    expect(b.current.lastActionDescription).toBe('Archive project')
  })

  it('clears canUndo once the last entry is undone', () => {
    const { result } = renderHook(() => useUndoTracker())

    act(() => {
      result.current.registerUndo('Delete task', vi.fn())
    })
    expect(result.current.canUndo).toBe(true)

    act(() => {
      result.current.undo()
    })

    expect(result.current.canUndo).toBe(false)
    expect(result.current.lastActionDescription).toBeNull()
  })

  it('clears canUndo when the last entry is removed by ID', () => {
    const { result } = renderHook(() => useUndoTracker())

    let id = ''
    act(() => {
      id = result.current.registerUndo('Delete task', vi.fn())
    })
    expect(result.current.canUndo).toBe(true)

    act(() => {
      result.current.removeUndoEntry(id)
    })

    expect(result.current.canUndo).toBe(false)
  })

  it('updates a mounted tracker when Cmd+Z consumes the entry', () => {
    Object.defineProperty(navigator, 'platform', { value: 'MacIntel', writable: true })

    const { result } = renderHook(() => useUndoTracker())
    const undoFn = vi.fn()

    act(() => {
      result.current.registerUndo('Delete task', undoFn)
    })
    expect(result.current.canUndo).toBe(true)

    renderHook(() => useUndoKeyboardShortcut())

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true }))
    })

    expect(undoFn).toHaveBeenCalledTimes(1)
    expect(result.current.canUndo).toBe(false)
  })

  it('drops the entry on the expiry sweep and re-renders subscribers', () => {
    vi.useFakeTimers()
    const start = Date.now()

    const { result } = renderHook(() => useUndoTracker())
    act(() => {
      result.current.registerUndo('Delete task', vi.fn())
    })
    expect(result.current.canUndo).toBe(true)

    vi.setSystemTime(start + UNDO_EXPIRY_MS + 1)
    act(() => {
      vi.advanceTimersByTime(1000)
    })

    expect(result.current.canUndo).toBe(false)
    expect(result.current.lastActionDescription).toBeNull()
  })

  it('undo() refuses an entry that expired since the last sweep', () => {
    vi.useFakeTimers()
    const start = Date.now()

    const { result } = renderHook(() => useUndoTracker())
    const undoFn = vi.fn()
    act(() => {
      result.current.registerUndo('Delete task', undoFn)
    })

    // Wall clock passes the expiry window, but the 1s sweep has not run yet.
    vi.setSystemTime(start + UNDO_EXPIRY_MS + 1)

    let success = true
    act(() => {
      success = result.current.undo()
    })

    expect(success).toBe(false)
    expect(undoFn).not.toHaveBeenCalled()
    expect(toast.success).not.toHaveBeenCalled()
    expect(result.current.canUndo).toBe(false)
  })

  it('undo() still runs a live entry and discards the expired one beneath it', () => {
    vi.useFakeTimers()
    const start = Date.now()

    const { result } = renderHook(() => useUndoTracker())
    const staleFn = vi.fn()
    const liveFn = vi.fn()

    act(() => {
      result.current.registerUndo('Stale action', staleFn)
    })

    vi.setSystemTime(start + UNDO_EXPIRY_MS - 1000)
    act(() => {
      result.current.registerUndo('Live action', liveFn)
    })

    // Only the first entry is past its window; no sweep has run.
    vi.setSystemTime(start + UNDO_EXPIRY_MS + 1)

    act(() => {
      expect(result.current.undo()).toBe(true)
    })
    expect(liveFn).toHaveBeenCalledTimes(1)

    act(() => {
      expect(result.current.undo()).toBe(false)
    })
    expect(staleFn).not.toHaveBeenCalled()
  })

  it('does not mutate module state during render', () => {
    vi.useFakeTimers()
    const start = Date.now()

    const { result, rerender } = renderHook(() => useUndoTracker())
    act(() => {
      result.current.registerUndo('Delete task', vi.fn())
    })

    // Wall clock passes the expiry window, but the 1s sweep has not run yet.
    vi.setSystemTime(start + UNDO_EXPIRY_MS + 1)

    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval')
    rerender()

    // Before the fix, render called getLastUndoEntry(), which filtered the
    // module-level stack and stopped the cleanup interval mid-render.
    expect(clearIntervalSpy).not.toHaveBeenCalled()
    clearIntervalSpy.mockRestore()
  })
})
