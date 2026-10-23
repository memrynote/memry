import { useCallback, useState } from 'react'
import { createLogger } from '@/lib/logger'

const log = createLogger('FoldHint')

const STORAGE_KEY = 'memry:note-fold-hint-seen'
const SEEN_VALUE = '1'

function readSeen(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === SEEN_VALUE
  } catch (error) {
    log.warn('Failed to read the fold hint flag from localStorage', error)
    // Unreadable storage: stay quiet rather than show the hint on every note.
    return true
  }
}

/**
 * Whether the one-time "this note can be folded" hint is still due. Device-local,
 * not per vault: a reader who has seen it on one vault knows the feature.
 */
export function useFoldHint(): readonly [boolean, () => void] {
  const [seen, setSeen] = useState(readSeen)
  const dismiss = useCallback(() => {
    setSeen(true)
    try {
      localStorage.setItem(STORAGE_KEY, SEEN_VALUE)
    } catch (error) {
      log.warn('Failed to persist the fold hint flag to localStorage', error)
    }
  }, [])
  return [!seen, dismiss] as const
}
