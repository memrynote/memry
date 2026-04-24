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
