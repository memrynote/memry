import { useEffect, useCallback } from 'react'
import { useShortcutBinding } from '@/lib/shortcut-bindings'
import { matchesShortcut } from './use-keyboard-shortcuts-base'

/**
 * Surfaces with their own ⌘K menu (the calendar timeline) mark their focus
 * root with this attribute. While focus is inside one, the primary chord goes
 * to that menu; ⌘P still opens search.
 */
export const LOCAL_COMMAND_MENU_ATTR = 'data-local-command-menu'

function focusOwnsCommandMenu(): boolean {
  const active = document.activeElement
  return active instanceof Element && active.closest(`[${LOCAL_COMMAND_MENU_ATTR}]`) !== null
}

/**
 * Global search. The primary chord is rebindable (`nav.search`, ⌘K by default);
 * ⌘P stays as a fixed alias for muscle memory from other editors.
 */
export function useSearchShortcut(onToggle: () => void): void {
  const binding = useShortcutBinding('nav.search')

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      const primary = matchesShortcut(e, binding.key, binding.modifiers)
      const matches =
        (primary && !focusOwnsCommandMenu()) || matchesShortcut(e, 'p', { meta: true })

      if (matches) {
        e.preventDefault()
        e.stopPropagation()
        onToggle()
      }
    },
    [binding, onToggle]
  )

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true })
  }, [handleKeyDown])
}
