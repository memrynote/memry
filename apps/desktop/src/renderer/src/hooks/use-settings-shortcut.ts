import { useMemo } from 'react'
import { useKeyboardShortcuts, type KeyboardShortcut } from './use-keyboard-shortcuts-base'

/**
 * Hook to register global ⌘, (Mac) / Ctrl+, (Windows/Linux) shortcut for opening settings.
 *
 * @param onOpen - Callback to open settings
 *
 * @example
 * ```tsx
 * useSettingsShortcut(() => openSettings())
 * ```
 */
export function useSettingsShortcut(onOpen: () => void): void {
  const shortcuts = useMemo<KeyboardShortcut[]>(
    () => [
      {
        key: ',',
        modifiers: { meta: true },
        action: onOpen,
        description: 'Open Settings',
        allowInInput: true
      }
    ],
    [onOpen]
  )

  useKeyboardShortcuts(shortcuts)
}
