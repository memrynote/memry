import { useMemo } from 'react'
import { useShortcutBinding } from '@/lib/shortcut-bindings'
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
  const binding = useShortcutBinding('nav.settings')

  const shortcuts = useMemo<KeyboardShortcut[]>(
    () => [
      {
        key: binding.key,
        modifiers: binding.modifiers,
        action: onOpen,
        description: 'Open Settings',
        allowInInput: true
      }
    ],
    [binding, onOpen]
  )

  useKeyboardShortcuts(shortcuts)
}
