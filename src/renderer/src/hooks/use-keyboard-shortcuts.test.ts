/**
 * useKeyboardShortcuts Hook Tests (T502-T504)
 * Tests for keyboard shortcuts utilities: OS detection, input focus detection, and helpers.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  isMac,
  modifierKey,
  altKey,
  isInputFocused,
  isQuickFileInput,
  getKeyboardShortcuts
} from './use-keyboard-shortcuts'

// ============================================================================
// Test Setup
// ============================================================================

describe('Keyboard Shortcuts Utilities', () => {
  // ==========================================================================
  // T502: OS Detection
  // ==========================================================================

  describe('OS detection', () => {
    it('should export isMac as a boolean', () => {
      expect(typeof isMac).toBe('boolean')
    })

    it('should export modifierKey based on platform', () => {
      // modifierKey is either "⌘" (Mac) or "Ctrl" (Windows/Linux)
      expect(['⌘', 'Ctrl']).toContain(modifierKey)
    })

    it('should export altKey based on platform', () => {
      // altKey is either "⌥" (Mac) or "Alt" (Windows/Linux)
      expect(['⌥', 'Alt']).toContain(altKey)
    })

    it('should have consistent modifier key with isMac', () => {
      if (isMac) {
        expect(modifierKey).toBe('⌘')
        expect(altKey).toBe('⌥')
      } else {
        expect(modifierKey).toBe('Ctrl')
        expect(altKey).toBe('Alt')
      }
    })
  })

  // ==========================================================================
  // T503: Input Focus Detection
  // ==========================================================================

  describe('input focus detection', () => {
    beforeEach(() => {
      // Reset DOM
      document.body.innerHTML = ''
    })

    afterEach(() => {
      document.body.innerHTML = ''
    })

    it('should return true when input is focused', () => {
      const input = document.createElement('input')
      document.body.appendChild(input)
      input.focus()

      expect(isInputFocused()).toBe(true)
    })

    it('should return true when textarea is focused', () => {
      const textarea = document.createElement('textarea')
      document.body.appendChild(textarea)
      textarea.focus()

      expect(isInputFocused()).toBe(true)
    })

    it('should return true when select is focused', () => {
      const select = document.createElement('select')
      document.body.appendChild(select)
      select.focus()

      expect(isInputFocused()).toBe(true)
    })

    it('should return true when contenteditable is focused', () => {
      const div = document.createElement('div')
      div.contentEditable = 'true'
      div.tabIndex = 0
      document.body.appendChild(div)
      div.focus()

      expect(isInputFocused()).toBe(true)
    })

    it('should return false when non-input element is focused', () => {
      const button = document.createElement('button')
      document.body.appendChild(button)
      button.focus()

      expect(isInputFocused()).toBe(false)
    })

    it('should return false when body is focused', () => {
      document.body.focus()

      expect(isInputFocused()).toBe(false)
    })
  })

  // ==========================================================================
  // Quick File Input Detection
  // ==========================================================================

  describe('quick file input detection', () => {
    it('should return true for quick file input', () => {
      const input = document.createElement('input')
      input.setAttribute('aria-label', 'Quick file folder search')

      expect(isQuickFileInput(input)).toBe(true)
    })

    it('should return false for regular input', () => {
      const input = document.createElement('input')
      input.setAttribute('aria-label', 'Search')

      expect(isQuickFileInput(input)).toBe(false)
    })

    it('should return false for null', () => {
      expect(isQuickFileInput(null)).toBe(false)
    })

    it('should return false for non-HTML elements', () => {
      expect(isQuickFileInput('not an element')).toBe(false)
    })

    it('should return false for element without aria-label', () => {
      const input = document.createElement('input')

      expect(isQuickFileInput(input)).toBe(false)
    })
  })

  // ==========================================================================
  // T504: Keyboard Shortcuts Configuration
  // ==========================================================================

  describe('keyboard shortcuts configuration', () => {
    it('should return an array of shortcut categories', () => {
      const shortcuts = getKeyboardShortcuts()

      expect(Array.isArray(shortcuts)).toBe(true)
      expect(shortcuts.length).toBeGreaterThan(0)
    })

    it('should have valid category structure', () => {
      const shortcuts = getKeyboardShortcuts()

      shortcuts.forEach((category) => {
        expect(category).toHaveProperty('title')
        expect(category).toHaveProperty('shortcuts')
        expect(typeof category.title).toBe('string')
        expect(Array.isArray(category.shortcuts)).toBe(true)
      })
    })

    it('should have valid shortcut structure', () => {
      const shortcuts = getKeyboardShortcuts()

      shortcuts.forEach((category) => {
        category.shortcuts.forEach((shortcut) => {
          expect(shortcut).toHaveProperty('key')
          expect(shortcut).toHaveProperty('label')
          expect(typeof shortcut.key).toBe('string')
          expect(typeof shortcut.label).toBe('string')
        })
      })
    })

    it('should include Navigation category', () => {
      const shortcuts = getKeyboardShortcuts()
      const navCategory = shortcuts.find((c) => c.title === 'Navigation')

      expect(navCategory).toBeDefined()
      expect(navCategory?.shortcuts.length).toBeGreaterThan(0)
    })

    it('should include Selection category', () => {
      const shortcuts = getKeyboardShortcuts()
      const selCategory = shortcuts.find((c) => c.title === 'Selection')

      expect(selCategory).toBeDefined()
      expect(selCategory?.shortcuts.length).toBeGreaterThan(0)
    })

    it('should include Actions category', () => {
      const shortcuts = getKeyboardShortcuts()
      const actCategory = shortcuts.find((c) => c.title === 'Actions')

      expect(actCategory).toBeDefined()
      expect(actCategory?.shortcuts.length).toBeGreaterThan(0)
    })

    it('should include Global category', () => {
      const shortcuts = getKeyboardShortcuts()
      const globalCategory = shortcuts.find((c) => c.title === 'Global')

      expect(globalCategory).toBeDefined()
      expect(globalCategory?.shortcuts.length).toBeGreaterThan(0)
    })

    it('should include platform-specific modifier in shortcuts', () => {
      const shortcuts = getKeyboardShortcuts()

      // Find a shortcut that uses the modifier key
      const selCategory = shortcuts.find((c) => c.title === 'Selection')
      const selectAllShortcut = selCategory?.shortcuts.find((s) => s.label === 'Select all')

      expect(selectAllShortcut).toBeDefined()
      expect(selectAllShortcut?.key).toContain(modifierKey)
    })

    it('should include Repeating Tasks category', () => {
      const shortcuts = getKeyboardShortcuts()
      const repeatCategory = shortcuts.find((c) => c.title === 'Repeating Tasks')

      expect(repeatCategory).toBeDefined()
      expect(repeatCategory?.shortcuts.length).toBeGreaterThan(0)
    })

    it('should have unique shortcut keys within each category', () => {
      const shortcuts = getKeyboardShortcuts()

      shortcuts.forEach((category) => {
        const keys = category.shortcuts.map((s) => s.key)
        const uniqueKeys = [...new Set(keys)]

        // Note: Some keys might intentionally repeat in different categories
        // but within a category they should be unique
        expect(keys.length).toBe(uniqueKeys.length)
      })
    })
  })
})

// ============================================================================
// Integration Tests
// ============================================================================

describe('Keyboard Shortcuts Integration', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('should allow shortcuts when focus is on non-input element', () => {
    const div = document.createElement('div')
    div.tabIndex = 0
    document.body.appendChild(div)
    div.focus()

    expect(isInputFocused()).toBe(false)
    // Shortcuts should be allowed
  })

  it('should block shortcuts when focus is on input element', () => {
    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()

    expect(isInputFocused()).toBe(true)
    // Shortcuts should be blocked (except for quick-file specific ones)
  })

  it('should allow some shortcuts for quick-file input', () => {
    const input = document.createElement('input')
    input.setAttribute('aria-label', 'Quick file folder search')
    document.body.appendChild(input)
    input.focus()

    expect(isInputFocused()).toBe(true)
    expect(isQuickFileInput(input)).toBe(true)
    // Quick-file specific shortcuts should be allowed
  })
})
