import { useCallback, useEffect } from 'react'
import { useShortcutBinding } from '@/lib/shortcut-bindings'
import { matchesShortcut } from './use-keyboard-shortcuts-base'
import { isPlainTextInputFocused } from './use-keyboard-shortcuts'

/**
 * Switch vault. ⌘⇧O (⌃⇧O off Mac) opens the sidebar's vault switcher from
 * anywhere, so switching no longer means reopening the sidebar by hand.
 *
 * The chord does not collide with any BlockNote/ProseMirror command, so it
 * must fire even while the caret sits in a note body — that is the whole
 * point of a global "jump elsewhere" shortcut. It only stands down over a
 * plain text input, textarea, or select, where typing the letter O is the
 * expected outcome (e.g. renaming a note).
 */
export function useSwitchVaultShortcut(onOpen: () => void): void {
  const binding = useShortcutBinding('nav.switchVault')

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!matchesShortcut(e, binding.key, binding.modifiers)) return
      if (isPlainTextInputFocused()) return

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
