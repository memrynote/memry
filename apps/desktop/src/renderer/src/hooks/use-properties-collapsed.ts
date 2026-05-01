import { useCallback, useState } from 'react'
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
  const [collapseState, setCollapseState] = useState(() => ({
    noteId,
    isCollapsed: readInitial(noteId)
  }))

  let currentState = collapseState
  if (currentState.noteId !== noteId) {
    currentState = { noteId, isCollapsed: readInitial(noteId) }
    setCollapseState(currentState)
  }

  const setCollapsed = useCallback(
    (next: boolean) => {
      setCollapseState({ noteId, isCollapsed: next })
      persist(noteId, next)
    },
    [noteId]
  )

  const toggle = useCallback(() => {
    setCollapseState((previous) => {
      const active =
        previous.noteId === noteId ? previous : { noteId, isCollapsed: readInitial(noteId) }
      const next = !active.isCollapsed
      persist(noteId, next)
      return { noteId, isCollapsed: next }
    })
  }, [noteId])

  return [currentState.isCollapsed, toggle, setCollapsed] as const
}
