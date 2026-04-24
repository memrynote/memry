import { useEffect, useCallback } from 'react'

interface UseSaveFilterShortcutOptions {
  onSave: () => void
  hasActiveFilters: boolean
  disabled?: boolean
}

export function useSaveFilterShortcut({
  onSave,
  hasActiveFilters,
  disabled = false
}: UseSaveFilterShortcutOptions): void {
  const handler = useCallback(
    (e: KeyboardEvent) => {
      if (disabled || !hasActiveFilters) return
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault()
        onSave()
      }
    },
    [onSave, hasActiveFilters, disabled]
  )

  useEffect(() => {
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [handler])
}
