import { useEffect, useCallback } from 'react'
import { useShortcutBinding } from '@/lib/shortcut-bindings'
import { matchesShortcut } from './use-keyboard-shortcuts-base'

/**
 * Global search. The primary chord is rebindable (`nav.search`, ⌘K by default);
 * ⌘P stays as a fixed alias for muscle memory from other editors.
 */
export function useSearchShortcut(onToggle: () => void): void {
  const binding = useShortcutBinding('nav.search')

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      const matches =
        matchesShortcut(e, binding.key, binding.modifiers) ||
        matchesShortcut(e, 'p', { meta: true })

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
