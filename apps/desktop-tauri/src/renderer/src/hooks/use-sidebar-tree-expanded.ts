import { useEffect, useState, type Dispatch, type SetStateAction } from 'react'
import { createLogger } from '@/lib/logger'

const log = createLogger('Hook:SidebarTreeExpanded')

/**
 * The Collections tree's expanded folders, read from and mirrored to `expandedKey`
 * (see `sidebarTreeExpandedKey`). The stored value is a JSON array of folder ids.
 *
 * `NotesTree` holds this one set and passes it to the plain tree and to the
 * virtualized tree, so a folder opened in one is open in the other however the
 * swap at the virtualization threshold lands. Storage only carries the set
 * across launches.
 */
export function useSidebarTreeExpanded(
  expandedKey: string
): [Set<string>, Dispatch<SetStateAction<Set<string>>>] {
  const [expandedIds, setExpandedIds] = useState(() => readExpandedIds(expandedKey))

  useEffect(() => {
    try {
      localStorage.setItem(expandedKey, JSON.stringify([...expandedIds]))
    } catch (error) {
      log.warn('could not save the expanded folders', { key: expandedKey, error })
    }
  }, [expandedKey, expandedIds])

  return [expandedIds, setExpandedIds]
}

function readExpandedIds(key: string): Set<string> {
  try {
    const stored = localStorage.getItem(key)
    if (stored === null) return new Set()
    const parsed: unknown = JSON.parse(stored)
    if (Array.isArray(parsed)) {
      return new Set(parsed.filter((id): id is string => typeof id === 'string'))
    }
    log.warn('the stored expanded folders are not a list', { key })
  } catch (error) {
    log.warn('could not read the expanded folders', { key, error })
  }
  return new Set()
}
