import { useEffect, useCallback } from 'react'
import { useShortcutBinding } from '@/lib/shortcut-bindings'
import { matchesShortcut } from './use-keyboard-shortcuts-base'

/**
 * Hook to register the New Note shortcut (⌘N / Ctrl+N by default, rebindable
 * from Settings → Shortcuts as `nav.newNote`).
 *
 * @param onNewNote - Callback to create and open a new note
 *
 * @example
 * ```tsx
 * useNewNoteShortcut(() => handleCreateNewNote())
 * ```
 */
export function useNewNoteShortcut(onNewNote: () => void): void {
  const binding = useShortcutBinding('nav.newNote')

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (matchesShortcut(e, binding.key, binding.modifiers)) {
        e.preventDefault()
        onNewNote()
      }
    },
    [binding, onNewNote]
  )

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])
}
