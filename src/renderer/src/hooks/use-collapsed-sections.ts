import { useState, useCallback, useEffect } from 'react'

const STORAGE_PREFIX = 'collapsedSections'

const getStorageKey = (viewKey: string): string => `${STORAGE_PREFIX}-${viewKey}`

const getDefaultCollapsed = (viewKey: string): Set<string> => {
  if (viewKey === 'today') return new Set(['this-week'])
  return new Set()
}

const loadFromStorage = (viewKey: string): Set<string> => {
  try {
    const stored = localStorage.getItem(getStorageKey(viewKey))
    if (stored) {
      const parsed = JSON.parse(stored)
      if (Array.isArray(parsed)) return new Set(parsed)
    }
  } catch {
    // Ignore
  }
  return getDefaultCollapsed(viewKey)
}

const saveToStorage = (viewKey: string, ids: Set<string>): void => {
  try {
    localStorage.setItem(getStorageKey(viewKey), JSON.stringify(Array.from(ids)))
  } catch {
    // Ignore
  }
}

interface UseCollapsedSectionsReturn {
  collapsedSections: Set<string>
  isCollapsed: (sectionKey: string) => boolean
  toggleSection: (sectionKey: string) => void
}

export const useCollapsedSections = (viewKey: string): UseCollapsedSectionsReturn => {
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(() =>
    loadFromStorage(viewKey)
  )

  useEffect(() => {
    saveToStorage(viewKey, collapsedSections)
  }, [collapsedSections, viewKey])

  useEffect(() => {
    setCollapsedSections(loadFromStorage(viewKey))
  }, [viewKey])

  const isCollapsed = useCallback(
    (sectionKey: string): boolean => collapsedSections.has(sectionKey),
    [collapsedSections]
  )

  const toggleSection = useCallback((sectionKey: string): void => {
    setCollapsedSections((prev) => {
      const next = new Set(prev)
      if (next.has(sectionKey)) {
        next.delete(sectionKey)
      } else {
        next.add(sectionKey)
      }
      return next
    })
  }, [])

  return { collapsedSections, isCollapsed, toggleSection }
}
