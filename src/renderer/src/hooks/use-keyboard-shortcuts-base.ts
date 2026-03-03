/**
 * Base Keyboard Shortcuts Hook
 * Handles keyboard event binding and shortcut matching
 */

import { useEffect, useCallback, useMemo } from 'react'

// =============================================================================
// TYPES
// =============================================================================

export interface KeyboardShortcut {
  /** Key to match (e.g., 'w', 'Tab', 'ArrowRight') */
  key: string
  /** Modifier keys */
  modifiers?: {
    /** Meta on Mac, Ctrl on Windows/Linux */
    meta?: boolean
    /** Always Ctrl (e.g., Ctrl+Tab) */
    ctrl?: boolean
    /** Shift key */
    shift?: boolean
    /** Alt/Option key */
    alt?: boolean
  }
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
// HOOK
// =============================================================================

/**
 * Hook to handle keyboard shortcuts
 */
export const useKeyboardShortcuts = (shortcuts: KeyboardShortcut[]): void => {
  // Memoize shortcuts to prevent unnecessary re-renders
  const memoizedShortcuts = useMemo(() => shortcuts, [shortcuts])

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      const target = e.target as HTMLElement

      // Check if typing in input/textarea
      const isInputField =
        target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable

      for (const shortcut of memoizedShortcuts) {
        const { key, modifiers = {}, action, when, allowInInput } = shortcut

        // Skip if in input and not allowed
        if (isInputField && !allowInInput) {
          // Allow Escape in inputs
          if (e.key !== 'Escape') continue
        }

        // Check condition
        if (when && !when()) continue

        // Check key match (case insensitive for letters)
        if (e.key.toLowerCase() !== key.toLowerCase()) continue

        // Check modifiers
        const metaOrCtrl = isMac ? e.metaKey : e.ctrlKey

        // Meta modifier (Cmd on Mac, Ctrl on Windows)
        if (modifiers.meta && !metaOrCtrl) continue
        if (!modifiers.meta && metaOrCtrl && !modifiers.ctrl) continue

        // Ctrl modifier (always Ctrl, e.g., Ctrl+Tab)
        if (modifiers.ctrl && !e.ctrlKey) continue

        // Shift modifier
        if (modifiers.shift !== undefined) {
          if (modifiers.shift && !e.shiftKey) continue
          if (!modifiers.shift && e.shiftKey) continue
        } else if (e.shiftKey) {
          continue
        }

        // Alt modifier
        if (modifiers.alt !== undefined) {
          if (modifiers.alt && !e.altKey) continue
          if (!modifiers.alt && e.altKey) continue
        } else if (e.altKey) {
          continue
        }

        // All checks passed - execute action
        e.preventDefault()
        e.stopPropagation()
        action()
        return
      }
    },
    [memoizedShortcuts]
  )

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])
}

export default useKeyboardShortcuts
