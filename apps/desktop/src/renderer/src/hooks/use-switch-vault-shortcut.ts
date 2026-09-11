import { useCallback, useEffect } from 'react'
import { useShortcutBinding } from '@/lib/shortcut-bindings'
import { matchesShortcut } from './use-keyboard-shortcuts-base'
import { isInputFocused } from './use-keyboard-shortcuts'

/**
 * Switch vault. ⌘⇧O (⌃⇧O off Mac) opens the sidebar's vault switcher from
 * anywhere, so switching no longer means reopening the sidebar by hand.
 *
 * The chord stands down while a text input, textarea, select, or rich-text
 * editor owns focus: those surfaces may map the same keys, and a shortcut that
 * steals a keystroke mid-sentence is worse than no shortcut.
 */
export function useSwitchVaultShortcut(onOpen: () => void): void {
  const binding = useShortcutBinding('nav.switchVault')

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!matchesShortcut(e, binding.key, binding.modifiers)) return
      if (isInputFocused()) return

      e.preventDefault()
      e.stopPropagation()
      onOpen()
    },
    [binding, onOpen]
  )

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true })
  }, [handleKeyDown])
}
