import { useCallback, useMemo } from 'react'
import { fuzzySearch } from '@/lib/fuzzy-search'
import { extractErrorMessage } from '@/lib/ipc-error'
import { getI18n } from 'react-i18next'
import { tagsService } from '@/services/tags-service'
import { useNoteTagsQuery } from './use-notes-query'

export interface Tag {
  name: string
  count: number
  color?: string
  icon?: string | null
}

/**
 * The tag list with search helpers. It reads the one cached tag list, whose refreshes
 * `useNoteMetadataEvents` (App) owns: a renamed or deleted tag also sends the tag-list event.
 */
export function useTags() {
  const tagsQuery = useNoteTagsQuery()
  const tags = useMemo(
    (): Tag[] =>
      tagsQuery.tags.map(({ tag, count, color, icon }) => ({ name: tag, count, color, icon })),
    [tagsQuery.tags]
  )
  const error = tagsQuery.error
    ? extractErrorMessage(
        tagsQuery.error,
        getI18n().getFixedT(null, 'settings')('phaseI.errors.failedToLoadTags')
      )
    : null

  const searchTags = useCallback(
    (query: string): Tag[] => {
      if (!query || query.trim() === '') {
        return tags.toSorted((a, b) => b.count - a.count)
      }

      const lastSlash = query.lastIndexOf('/')
      if (lastSlash !== -1) {
        const prefix = query.slice(0, lastSlash).toLowerCase()
        const leafQuery = query.slice(lastSlash + 1).toLowerCase()
        const prefixWithSlash = prefix + '/'
        const prefixDepth = prefix.split('/').length

        return tags
          .filter((t) => {
            if (!t.name.toLowerCase().startsWith(prefixWithSlash)) return false
            const segments = t.name.split('/')
            if (segments.length !== prefixDepth + 1) return false
            if (!leafQuery) return true
            const leaf = segments[segments.length - 1]
            return leaf.toLowerCase().includes(leafQuery)
          })
          .toSorted((a, b) => b.count - a.count)
      }

      const filtered = fuzzySearch(tags, query, ['name'])
      return filtered.toSorted((a, b) => b.count - a.count)
    },
    [tags]
  )

  const getPopularTags = useCallback(
    (limit = 10): Tag[] => {
      return tags.toSorted((a, b) => b.count - a.count).slice(0, limit)
    },
    [tags]
  )

  const getRecentTags = useCallback(
    (limit = 5): Tag[] => {
      return tags.toSorted((a, b) => b.count - a.count).slice(0, limit)
    },
    [tags]
  )

  const mergeTag = useCallback(async (source: string, target: string) => {
    return tagsService.mergeTag({ source, target })
  }, [])

  const deleteTag = useCallback(async (tag: string) => {
    return tagsService.deleteTag(tag)
  }, [])

  const refetch = tagsQuery.refetch

  return {
    tags,
    isLoading: tagsQuery.isLoading,
    error,
    searchTags,
    getPopularTags,
    getRecentTags,
    mergeTag,
    deleteTag,
    refetch
  }
}
