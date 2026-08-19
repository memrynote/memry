/**
 * Base Keyboard Shortcuts Hook
 * Handles keyboard event binding and shortcut matching
 */

import { useEffect, useRef } from 'react'
import { hintModeActiveRef } from '@/contexts/hint-mode'

// =============================================================================
// TYPES
// =============================================================================

export interface ShortcutModifiers {
  /** Meta on Mac, Ctrl on Windows/Linux */
  meta?: boolean
  /** Always Ctrl (e.g., Ctrl+Tab) */
  ctrl?: boolean
  /** Shift key */
  shift?: boolean
  /** Alt/Option key */
  alt?: boolean
}

export interface KeyboardShortcut {
  /** Key to match (e.g., 'w', 'Tab', 'ArrowRight') */
  key: string
  /** Modifier keys */
  modifiers?: ShortcutModifiers
  /** Action to execute */
  action: () => void
  /** Human-readable description */
  description: string
  /** Condition for shortcut to be active */
  when?: () => boolean
  /** Allow in input fields */
  allowInInput?: boolean
}

// =============================================================================
// PLATFORM DETECTION
// =============================================================================

/**
 * Detect if running on Mac
 */
export const isMac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform)

/**
 * Get platform-specific modifier key label
 */
export const getModifierSymbol = (modifier: 'meta' | 'ctrl' | 'shift' | 'alt'): string => {
  switch (modifier) {
    case 'meta':
      return isMac ? '⌘' : 'Ctrl'
    case 'ctrl':
      return 'Ctrl'
    case 'shift':
      return isMac ? '⇧' : 'Shift'
    case 'alt':
      return isMac ? '⌥' : 'Alt'
  }
}

// =============================================================================
// MATCHING
// =============================================================================

/**
 * Does this keydown match the given chord?
 *
 * Shared with the raw-listener shortcut owners (new note, search, shortcuts
 * help) so every surface resolves a rebindable binding the same way.
 */
export const matchesShortcut = (
  e: KeyboardEvent,
  key: string,
  modifiers: ShortcutModifiers = {}
): boolean => {
  // Key match (case insensitive for letters)
  if (!key) return false
  if (e.key.toLowerCase() !== key.toLowerCase()) return false

  // Meta modifier (Cmd on Mac, Ctrl on Windows)
  const metaOrCtrl = isMac ? e.metaKey : e.ctrlKey
  if (modifiers.meta && !metaOrCtrl) return false
  if (!modifiers.meta && metaOrCtrl && !modifiers.ctrl) return false

  // Ctrl modifier (always Ctrl, e.g., Ctrl+Tab)
  if (modifiers.ctrl && !e.ctrlKey) return false

  // Shift modifier
  if (modifiers.shift !== undefined) {
    if (modifiers.shift && !e.shiftKey) return false
    if (!modifiers.shift && e.shiftKey) return false
  } else if (e.shiftKey) {
    return false
  }

  // Alt modifier
  if (modifiers.alt !== undefined) {
    if (modifiers.alt && !e.altKey) return false
    if (!modifiers.alt && e.altKey) return false
  } else if (e.altKey) {
    return false
  }

  return true
}

// =============================================================================
// HOOK
// =============================================================================

export interface UseKeyboardShortcutsOptions {
  /**
   * Listen in the capture phase so matched shortcuts fire before input/editor
   * keydown handlers that may call stopPropagation (e.g. the tasks quick-add
   * input, inbox composer, or the note editor). Only matched shortcuts are
   * intercepted; all other keystrokes pass through untouched.
   */
  capture?: boolean
}

/**
 * Hook to handle keyboard shortcuts
 */
export const useKeyboardShortcuts = (
  shortcuts: KeyboardShortcut[],
  options: UseKeyboardShortcutsOptions = {}
): void => {
  const { capture = false } = options
  // Callers rebuild the shortcut array whenever their state changes. Read it
  // from a ref at keypress time so the window listener binds once per mount
  // instead of detaching/reattaching on every render.
  const shortcutsRef = useRef(shortcuts)

  useEffect(() => {
    shortcutsRef.current = shortcuts
  }, [shortcuts])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (hintModeActiveRef.current) return

      const target = e.target as HTMLElement

      // Check if typing in input/textarea
      const isInputField =
        target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable

      for (const shortcut of shortcutsRef.current) {
        const { key, modifiers = {}, action, when, allowInInput } = shortcut

        // Skip if in input and not allowed
        if (isInputField && !allowInInput) {
          // Allow Escape in inputs
          if (e.key !== 'Escape') continue
        }

        // Check condition
        if (when && !when()) continue

        // Check key and modifiers
        if (!matchesShortcut(e, key, modifiers)) continue

        // All checks passed - execute action
        e.preventDefault()
        e.stopPropagation()
        action()
        return
      }
    }

    window.addEventListener('keydown', handleKeyDown, capture)
    return () => window.removeEventListener('keydown', handleKeyDown, capture)
  }, [capture])
}

export default useKeyboardShortcuts
