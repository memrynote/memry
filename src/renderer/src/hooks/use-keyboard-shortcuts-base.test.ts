/**
 * useKeyboardShortcuts Base Hook Tests (T669)
 * Tests for keyboard event binding and shortcut matching.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import {
  useKeyboardShortcuts,
  isMac,
  getModifierSymbol,
  type KeyboardShortcut
} from './use-keyboard-shortcuts-base'

// ============================================================================
// Test Helpers
// ============================================================================

const mockPlatform = (platform: string) => {
  Object.defineProperty(navigator, 'platform', {
    value: platform,
    configurable: true
  })
}

const createKeyboardEvent = (
  key: string,
  options: Partial<KeyboardEventInit> = {}
): KeyboardEvent => {
  return new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
    ...options
  })
}

// ============================================================================
// Tests
// ============================================================================

describe('useKeyboardShortcuts', () => {
  let originalPlatform: string

  beforeEach(() => {
    originalPlatform = navigator.platform
    vi.clearAllMocks()
  })

  afterEach(() => {
    Object.defineProperty(navigator, 'platform', {
      value: originalPlatform,
      configurable: true
    })
  })

  // ==========================================================================
  // Event Listener Tests
  // ==========================================================================

  describe('event listener management', () => {
    it('should add keydown event listener on mount', () => {
      const addEventListenerSpy = vi.spyOn(window, 'addEventListener')
      const action = vi.fn()

      renderHook(() =>
        useKeyboardShortcuts([
          { key: 'a', action, description: 'Test' }
        ])
      )

      expect(addEventListenerSpy).toHaveBeenCalledWith('keydown', expect.any(Function))
    })

    it('should remove keydown event listener on unmount', () => {
      const removeEventListenerSpy = vi.spyOn(window, 'removeEventListener')
      const action = vi.fn()

      const { unmount } = renderHook(() =>
        useKeyboardShortcuts([
          { key: 'a', action, description: 'Test' }
        ])
      )

      unmount()

      expect(removeEventListenerSpy).toHaveBeenCalledWith('keydown', expect.any(Function))
    })
  })

  // ==========================================================================
  // Basic Key Matching Tests
  // ==========================================================================

  describe('key matching', () => {
    it('should trigger action for matching key', () => {
      const action = vi.fn()

      renderHook(() =>
        useKeyboardShortcuts([
          { key: 'a', action, description: 'Test A' }
        ])
      )

      act(() => {
        window.dispatchEvent(createKeyboardEvent('a'))
      })

      expect(action).toHaveBeenCalledTimes(1)
    })

    it('should be case insensitive for key matching', () => {
      const action = vi.fn()

      renderHook(() =>
        useKeyboardShortcuts([
          { key: 'A', action, description: 'Test A' }
        ])
      )

      act(() => {
        window.dispatchEvent(createKeyboardEvent('a'))
      })

      expect(action).toHaveBeenCalledTimes(1)
    })

    it('should not trigger action for non-matching key', () => {
      const action = vi.fn()

      renderHook(() =>
        useKeyboardShortcuts([
          { key: 'a', action, description: 'Test A' }
        ])
      )

      act(() => {
        window.dispatchEvent(createKeyboardEvent('b'))
      })

      expect(action).not.toHaveBeenCalled()
    })

    it('should prevent default and stop propagation on match', () => {
      const action = vi.fn()

      renderHook(() =>
        useKeyboardShortcuts([
          { key: 'a', action, description: 'Test A' }
        ])
      )

      const event = createKeyboardEvent('a')
      const preventDefaultSpy = vi.spyOn(event, 'preventDefault')
      const stopPropagationSpy = vi.spyOn(event, 'stopPropagation')

      act(() => {
        window.dispatchEvent(event)
      })

      expect(preventDefaultSpy).toHaveBeenCalled()
      expect(stopPropagationSpy).toHaveBeenCalled()
    })
  })

  // ==========================================================================
  // Modifier Key Tests
  // ==========================================================================

  describe('modifier keys', () => {
    it('should match meta modifier', () => {
      const action = vi.fn()

      renderHook(() =>
        useKeyboardShortcuts([
          { key: 's', modifiers: { meta: true }, action, description: 'Save' }
        ])
      )

      // Without meta/ctrl - should not match
      act(() => {
        window.dispatchEvent(createKeyboardEvent('s'))
      })
      expect(action).not.toHaveBeenCalled()

      // With meta - should match (on Mac) or ctrlKey (on non-Mac)
      // The isMac constant is determined at module load time
      const modifierEvent = createKeyboardEvent('s', { metaKey: true, ctrlKey: true })
      act(() => {
        window.dispatchEvent(modifierEvent)
      })
      expect(action).toHaveBeenCalledTimes(1)
    })

    it('should match ctrl modifier', () => {
      const action = vi.fn()

      renderHook(() =>
        useKeyboardShortcuts([
          { key: 'Tab', modifiers: { ctrl: true }, action, description: 'Next Tab' }
        ])
      )

      // Without ctrl - should not match
      act(() => {
        window.dispatchEvent(createKeyboardEvent('Tab'))
      })
      expect(action).not.toHaveBeenCalled()

      // With ctrl - should match
      act(() => {
        window.dispatchEvent(createKeyboardEvent('Tab', { ctrlKey: true }))
      })
      expect(action).toHaveBeenCalledTimes(1)
    })

    it('should match shift modifier', () => {
      const action = vi.fn()

      renderHook(() =>
        useKeyboardShortcuts([
          { key: 'Tab', modifiers: { shift: true }, action, description: 'Prev Tab' }
        ])
      )

      // Without shift - should not match
      act(() => {
        window.dispatchEvent(createKeyboardEvent('Tab'))
      })
      expect(action).not.toHaveBeenCalled()

      // With shift - should match
      act(() => {
        window.dispatchEvent(createKeyboardEvent('Tab', { shiftKey: true }))
      })
      expect(action).toHaveBeenCalledTimes(1)
    })

    it('should match alt modifier', () => {
      const action = vi.fn()

      renderHook(() =>
        useKeyboardShortcuts([
          { key: 'n', modifiers: { alt: true }, action, description: 'Alt N' }
        ])
      )

      // Without alt - should not match
      act(() => {
        window.dispatchEvent(createKeyboardEvent('n'))
      })
      expect(action).not.toHaveBeenCalled()

      // With alt - should match
      act(() => {
        window.dispatchEvent(createKeyboardEvent('n', { altKey: true }))
      })
      expect(action).toHaveBeenCalledTimes(1)
    })

    it('should reject unexpected modifier keys', () => {
      const action = vi.fn()

      renderHook(() =>
        useKeyboardShortcuts([
          { key: 'a', action, description: 'Test A' }
        ])
      )

      // With shift - should not match (no shift expected)
      act(() => {
        window.dispatchEvent(createKeyboardEvent('a', { shiftKey: true }))
      })
      expect(action).not.toHaveBeenCalled()

      // With alt - should not match (no alt expected)
      act(() => {
        window.dispatchEvent(createKeyboardEvent('a', { altKey: true }))
      })
      expect(action).not.toHaveBeenCalled()
    })
  })

  // ==========================================================================
  // Input Field Tests
  // ==========================================================================

  describe('input field handling', () => {
    it('should not trigger shortcuts in input fields by default', () => {
      const action = vi.fn()

      renderHook(() =>
        useKeyboardShortcuts([
          { key: 'a', action, description: 'Test A' }
        ])
      )

      const input = document.createElement('input')
      document.body.appendChild(input)

      const event = createKeyboardEvent('a')
      Object.defineProperty(event, 'target', { value: input })

      act(() => {
        window.dispatchEvent(event)
      })

      expect(action).not.toHaveBeenCalled()
      document.body.removeChild(input)
    })

    it('should trigger shortcuts in input fields when allowInInput is true', () => {
      const action = vi.fn()

      renderHook(() =>
        useKeyboardShortcuts([
          { key: 'a', action, description: 'Test A', allowInInput: true }
        ])
      )

      const input = document.createElement('input')
      document.body.appendChild(input)

      const event = createKeyboardEvent('a')
      Object.defineProperty(event, 'target', { value: input })

      act(() => {
        window.dispatchEvent(event)
      })

      expect(action).toHaveBeenCalledTimes(1)
      document.body.removeChild(input)
    })

    it('should always allow Escape in input fields', () => {
      const action = vi.fn()

      renderHook(() =>
        useKeyboardShortcuts([
          { key: 'Escape', action, description: 'Close' }
        ])
      )

      const input = document.createElement('input')
      document.body.appendChild(input)

      const event = createKeyboardEvent('Escape')
      Object.defineProperty(event, 'target', { value: input })

      act(() => {
        window.dispatchEvent(event)
      })

      expect(action).toHaveBeenCalledTimes(1)
      document.body.removeChild(input)
    })

    it('should not trigger shortcuts in textarea', () => {
      const action = vi.fn()

      renderHook(() =>
        useKeyboardShortcuts([
          { key: 'a', action, description: 'Test A' }
        ])
      )

      const textarea = document.createElement('textarea')
      document.body.appendChild(textarea)

      const event = createKeyboardEvent('a')
      Object.defineProperty(event, 'target', { value: textarea })

      act(() => {
        window.dispatchEvent(event)
      })

      expect(action).not.toHaveBeenCalled()
      document.body.removeChild(textarea)
    })

    it('should not trigger shortcuts in contentEditable', () => {
      const action = vi.fn()

      renderHook(() =>
        useKeyboardShortcuts([
          { key: 'a', action, description: 'Test A' }
        ])
      )

      // Create a mock element with isContentEditable property
      const mockTarget = {
        tagName: 'DIV',
        isContentEditable: true
      }

      const event = createKeyboardEvent('a')
      Object.defineProperty(event, 'target', { value: mockTarget })

      act(() => {
        window.dispatchEvent(event)
      })

      expect(action).not.toHaveBeenCalled()
    })
  })

  // ==========================================================================
  // Condition Tests
  // ==========================================================================

  describe('when condition', () => {
    it('should not trigger action when condition returns false', () => {
      const action = vi.fn()
      const when = vi.fn(() => false)

      renderHook(() =>
        useKeyboardShortcuts([
          { key: 'a', action, description: 'Test A', when }
        ])
      )

      act(() => {
        window.dispatchEvent(createKeyboardEvent('a'))
      })

      expect(when).toHaveBeenCalled()
      expect(action).not.toHaveBeenCalled()
    })

    it('should trigger action when condition returns true', () => {
      const action = vi.fn()
      const when = vi.fn(() => true)

      renderHook(() =>
        useKeyboardShortcuts([
          { key: 'a', action, description: 'Test A', when }
        ])
      )

      act(() => {
        window.dispatchEvent(createKeyboardEvent('a'))
      })

      expect(when).toHaveBeenCalled()
      expect(action).toHaveBeenCalledTimes(1)
    })
  })

  // ==========================================================================
  // Multiple Shortcuts Tests
  // ==========================================================================

  describe('multiple shortcuts', () => {
    it('should match first matching shortcut', () => {
      const action1 = vi.fn()
      const action2 = vi.fn()

      renderHook(() =>
        useKeyboardShortcuts([
          { key: 'a', action: action1, description: 'First' },
          { key: 'a', action: action2, description: 'Second' }
        ])
      )

      act(() => {
        window.dispatchEvent(createKeyboardEvent('a'))
      })

      expect(action1).toHaveBeenCalledTimes(1)
      expect(action2).not.toHaveBeenCalled()
    })

    it('should handle multiple different shortcuts', () => {
      const actionA = vi.fn()
      const actionB = vi.fn()
      const actionC = vi.fn()

      renderHook(() =>
        useKeyboardShortcuts([
          { key: 'a', action: actionA, description: 'Test A' },
          { key: 'b', action: actionB, description: 'Test B' },
          { key: 'c', action: actionC, description: 'Test C' }
        ])
      )

      act(() => {
        window.dispatchEvent(createKeyboardEvent('b'))
      })

      expect(actionA).not.toHaveBeenCalled()
      expect(actionB).toHaveBeenCalledTimes(1)
      expect(actionC).not.toHaveBeenCalled()
    })
  })
})

// ============================================================================
// Utility Function Tests
// ============================================================================

describe('isMac', () => {
  it('should be a boolean', () => {
    expect(typeof isMac).toBe('boolean')
  })
})

describe('getModifierSymbol', () => {
  it('should return symbols for Mac', () => {
    // Note: getModifierSymbol uses the module-level isMac constant
    // These tests will depend on the test environment platform
    const symbol = getModifierSymbol('meta')
    expect(typeof symbol).toBe('string')
    expect(symbol.length).toBeGreaterThan(0)
  })

  it('should return symbol for shift', () => {
    const symbol = getModifierSymbol('shift')
    expect(typeof symbol).toBe('string')
  })

  it('should return symbol for alt', () => {
    const symbol = getModifierSymbol('alt')
    expect(typeof symbol).toBe('string')
  })

  it('should return Ctrl for ctrl', () => {
    const symbol = getModifierSymbol('ctrl')
    expect(symbol).toBe('Ctrl')
  })
})
