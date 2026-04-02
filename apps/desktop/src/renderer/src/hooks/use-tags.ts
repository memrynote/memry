import { useState, useCallback, useEffect, useRef } from 'react'
import { createLogger } from '@/lib/logger'
import { fuzzySearch } from '@/lib/fuzzy-search'
import { extractErrorMessage } from '@/lib/ipc-error'

const log = createLogger('Hook:Tags')

export interface Tag {
  name: string
  count: number
  color?: string
}

export function useTags() {
  const [tags, setTags] = useState<Tag[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const mountedRef = useRef(true)

  const fetchTags = useCallback(async () => {
    try {
      const result = await window.api.tags.getAllWithCounts()
      if (!mountedRef.current) return
      setTags(result.tags)
      setError(null)
    } catch (err) {
      if (!mountedRef.current) return
      const message = extractErrorMessage(err, 'Failed to load tags')
      log.error('Failed to fetch tags:', err)
      setError(message)
    } finally {
      if (mountedRef.current) setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    void fetchTags()
    return () => {
      mountedRef.current = false
    }
  }, [fetchTags])

  useEffect(() => {
    const refetch = () => void fetchTags()
    const unsubs = [
      window.api.onTagsChanged(refetch),
      window.api.onTagRenamed(refetch),
      window.api.onTagDeleted(refetch)
    ]
    return () => unsubs.forEach((unsub) => unsub())
  }, [fetchTags])

  const searchTags = useCallback(
    (query: string): Tag[] => {
      if (!query || query.trim() === '') {
        return [...tags].sort((a, b) => b.count - a.count)
      }

      const lastSlash = query.lastIndexOf('/')
      if (lastSlash !== -1) {
        const prefix = query.slice(0, lastSlash).toLowerCase()
        const leafQuery = query.slice(lastSlash + 1).toLowerCase()
        const prefixWithSlash = prefix + '/'
        const prefixDepth = prefix.split('/').length

        return tags
          .filter((t) => {
            if (!t.name.startsWith(prefixWithSlash)) return false
            const segments = t.name.split('/')
            if (segments.length !== prefixDepth + 1) return false
            if (!leafQuery) return true
            const leaf = segments[segments.length - 1]
            return leaf.includes(leafQuery)
          })
          .sort((a, b) => b.count - a.count)
      }

      const filtered = fuzzySearch(tags, query, ['name'])
      return filtered.sort((a, b) => b.count - a.count)
    },
    [tags]
  )

  const getPopularTags = useCallback(
    (limit = 10): Tag[] => {
      return [...tags].sort((a, b) => b.count - a.count).slice(0, limit)
    },
    [tags]
  )

  const getRecentTags = useCallback(
    (limit = 5): Tag[] => {
      return [...tags].sort((a, b) => b.count - a.count).slice(0, limit)
    },
    [tags]
  )

  const renameTag = useCallback(async (oldName: string, newName: string) => {
    return window.api.tags.renameTag({ oldName, newName })
  }, [])

  const mergeTag = useCallback(async (source: string, target: string) => {
    return window.api.tags.mergeTag({ source, target })
  }, [])

  const deleteTag = useCallback(async (tag: string) => {
    return window.api.tags.deleteTag(tag)
  }, [])

  const refetch = fetchTags

  return {
    tags,
    isLoading,
    error,
    searchTags,
    getPopularTags,
    getRecentTags,
    renameTag,
    mergeTag,
    deleteTag,
    refetch
  }
}
