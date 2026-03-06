import { useEffect, useCallback } from 'react'

/**
 * Hook to register global ⌘P (Mac) / Ctrl+P (Windows/Linux) shortcut for search.
 *
 * @param onOpen - Callback to open the search modal
 *
 * @example
 * ```tsx
 * const [searchOpen, setSearchOpen] = useState(false)
 * useSearchShortcut(() => setSearchOpen(true))
 * ```
 */
export function useSearchShortcut(onOpen: () => void): void {
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      // ⌘P on Mac, Ctrl+P on Windows/Linux
      const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0
      const modifier = isMac ? e.metaKey : e.ctrlKey

      if (modifier && e.key.toLowerCase() === 'p') {
        e.preventDefault()
        onOpen()
      }
    },
    [onOpen]
  )

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])
}
