import { useCallback, useEffect } from 'react'
import { useShortcutBinding } from '@/lib/shortcut-bindings'
import { chordAllowedInInput, matchesShortcut } from './use-keyboard-shortcuts-base'
import { isPlainTextInputFocused } from './use-keyboard-shortcuts'
import { getVaultSwitchState } from '@/lib/vault-switch-state'

/**
 * Switch vault. ⌘⇧O (⌃⇧O off Mac) opens the sidebar's vault switcher from
 * anywhere, so switching no longer means reopening the sidebar by hand.
 *
 * The chord does not collide with any BlockNote/ProseMirror command, so it
 * fires wherever the caret is — note body, title, or any other field — which
 * is the whole point of a global "jump elsewhere" shortcut. Only a rebind
 * without ⌘/Ctrl stands down over a plain field, where it would eat typing.
 */
export function useSwitchVaultShortcut(onOpen: () => void): void {
  const binding = useShortcutBinding('nav.switchVault')

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!matchesShortcut(e, binding.key, binding.modifiers)) return
      if (!chordAllowedInInput(binding) && isPlainTextInputFocused()) return

      e.preventDefault()
      e.stopPropagation()
      // This listener sits on window, so the inert workspace does not stop it
      // mid-switch; a switcher opened then could start a second switch.
      if (getVaultSwitchState().pending) return
      onOpen()
    },
    [binding, onOpen]
  )

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true })
  }, [handleKeyDown])
}
