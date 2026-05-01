import { useCallback, useEffect, useState } from 'react'
import { createLogger } from '@/lib/logger'

const log = createLogger('PropertiesCollapsed')

const STORAGE_PREFIX = 'memry:properties-collapsed:'
const COLLAPSED_VALUE = '1'

const storageKey = (noteId: string): string => `${STORAGE_PREFIX}${noteId}`

const readInitial = (noteId: string): boolean => {
  if (!noteId) return false
  try {
    return localStorage.getItem(storageKey(noteId)) === COLLAPSED_VALUE
  } catch (error) {
    log.warn('Failed to read collapse state from localStorage', error)
    return false
  }
}

const persist = (noteId: string, collapsed: boolean): void => {
  if (!noteId) return
  try {
    if (collapsed) {
      localStorage.setItem(storageKey(noteId), COLLAPSED_VALUE)
    } else {
      localStorage.removeItem(storageKey(noteId))
    }
  } catch (error) {
    log.warn('Failed to persist collapse state to localStorage', error)
  }
}

/**
 * Per-note collapse state for the properties panel.
 * Backed by localStorage. Device-local by design.
 *
 * @param noteId Stable id of the note or journal entry. Empty string disables persistence.
 * @returns [isCollapsed, toggle, setCollapsed]
 */
export function usePropertiesCollapsed(
  noteId: string
): readonly [boolean, () => void, (next: boolean) => void] {
  const [isCollapsed, setState] = useState<boolean>(() => readInitial(noteId))

  useEffect(() => {
    setState(readInitial(noteId))
  }, [noteId])

  const setCollapsed = useCallback(
    (next: boolean) => {
      setState(next)
      persist(noteId, next)
    },
    [noteId]
  )

  const toggle = useCallback(() => {
    setState((prev) => {
      const next = !prev
      persist(noteId, next)
      return next
    })
  }, [noteId])

  return [isCollapsed, toggle, setCollapsed] as const
}
