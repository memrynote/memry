import { useEffect, useCallback } from 'react'

export function useSearchShortcut(onToggle: () => void): void {
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0
      const modifier = isMac ? e.metaKey : e.ctrlKey

      const key = e.key.toLowerCase()
      if (modifier && (key === 'k' || key === 'p')) {
        e.preventDefault()
        e.stopPropagation()
        onToggle()
      }
    },
    [onToggle]
  )

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true })
  }, [handleKeyDown])
}
