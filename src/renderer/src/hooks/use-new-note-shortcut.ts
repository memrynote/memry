import { useEffect, useCallback } from 'react'

/**
 * Hook to register global ⌘N (Mac) / Ctrl+N (Windows/Linux) shortcut for creating a new note.
 *
 * @param onNewNote - Callback to create and open a new note
 *
 * @example
 * ```tsx
 * useNewNoteShortcut(() => handleCreateNewNote())
 * ```
 */
export function useNewNoteShortcut(onNewNote: () => void): void {
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      // ⌘N on Mac, Ctrl+N on Windows/Linux
      const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0
      const modifier = isMac ? e.metaKey : e.ctrlKey

      if (modifier && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        onNewNote()
      }
    },
    [onNewNote]
  )

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])
}
