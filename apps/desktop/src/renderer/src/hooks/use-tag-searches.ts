/**
 * Saved multi-tag searches, read from and written to the vault's settings
 * through IPC — never to browser storage, so a saved search survives a
 * restart and belongs to the vault rather than to one machine's renderer.
 *
 * @module hooks/use-tag-searches
 */

import { useCallback } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { MAX_SAVED_TAG_SEARCHES, type TagSearch } from '@memry/contracts/tag-searches-api'

const TAG_SEARCHES_KEY = ['settings', 'tagSearches'] as const

const EMPTY: TagSearch[] = []

export interface UseTagSearchesResult {
  searches: TagSearch[]
  isLoading: boolean
  /** Append a named search. Returns false when the name or tag list is unusable. */
  saveSearch: (name: string, tags: string[]) => boolean
  deleteSearch: (id: string) => void
}

export function useTagSearches(): UseTagSearchesResult {
  const queryClient = useQueryClient()

  const { data, isLoading } = useQuery({
    queryKey: TAG_SEARCHES_KEY,
    queryFn: () => window.api.settings.getTagSearches(),
    staleTime: Infinity
  })

  const searches = data ?? EMPTY

  const mutation = useMutation({
    mutationFn: (next: TagSearch[]) => window.api.settings.setTagSearches(next),
    onMutate: async (next) => {
      await queryClient.cancelQueries({ queryKey: TAG_SEARCHES_KEY })
      const previous = queryClient.getQueryData<TagSearch[]>(TAG_SEARCHES_KEY)
      queryClient.setQueryData<TagSearch[]>(TAG_SEARCHES_KEY, next)
      return { previous }
    },
    onError: (_err, _next, context) => {
      if (context?.previous) queryClient.setQueryData(TAG_SEARCHES_KEY, context.previous)
    },
    onSuccess: (saved) => {
      // The main process is the authority on what was actually persisted.
      queryClient.setQueryData<TagSearch[]>(TAG_SEARCHES_KEY, saved)
    }
  })

  const { mutate } = mutation

  const saveSearch = useCallback(
    (name: string, tags: string[]): boolean => {
      const trimmedName = name.trim()
      const trimmedTags = tags.map((tag) => tag.trim()).filter((tag) => tag !== '')
      if (trimmedName === '' || trimmedTags.length === 0) return false
      if (searches.length >= MAX_SAVED_TAG_SEARCHES) return false
      const entry: TagSearch = {
        id: `tagsearch_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        name: trimmedName,
        tags: trimmedTags,
        createdAt: new Date().toISOString()
      }
      mutate([...searches, entry])
      return true
    },
    [mutate, searches]
  )

  const deleteSearch = useCallback(
    (id: string): void => {
      mutate(searches.filter((search) => search.id !== id))
    },
    [mutate, searches]
  )

  return { searches, isLoading, saveSearch, deleteSearch }
}
