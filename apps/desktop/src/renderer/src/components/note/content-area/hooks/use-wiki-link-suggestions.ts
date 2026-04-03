/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any */

import { useCallback, useRef } from 'react'
import { fuzzySearch } from '@/lib/fuzzy-search'
import { notesService } from '@/services/notes-service'
import { createWikiLinkInlineContent } from '../wiki-link'
import { splitWikiLinkQuery } from '../wiki-link-utils'
import type { WikiLinkSuggestionItem } from '../wiki-link-menu'
import { createLogger } from '@/lib/logger'

const log = createLogger('Hook:WikiLinkSuggestions')

type NoteSuggestion = {
  id: string
  title: string
  modified?: Date | string
}

export function useWikiLinkSuggestions(editor: any) {
  const notesCacheRef = useRef<{ notes: NoteSuggestion[]; fetchedAt: number } | null>(
    null
  )

  const getWikiLinkItems = useCallback(
    async (query: string): Promise<WikiLinkSuggestionItem[]> => {
      const now = Date.now()
      const cache = notesCacheRef.current
      const shouldRefresh = !cache || now - cache.fetchedAt > 5000
      if (shouldRefresh) {
        try {
          const result = await notesService.list({ limit: 500, sortBy: 'modified' })
          notesCacheRef.current = {
            notes: result.notes.map((note) => ({
              id: note.id,
              title: note.title,
              modified: note.modified
            })),
            fetchedAt: now
          }
        } catch (error) {
          log.error('Failed to load wiki link suggestions', error)
          notesCacheRef.current = { notes: [], fetchedAt: now }
        }
      }

      const notes = notesCacheRef.current?.notes ?? []
      const { search, alias } = splitWikiLinkQuery(query)
      const filtered = search ? fuzzySearch(notes, search, ['title']) : notes
      const sorted = filtered.slice(0, 10)

      const suggestions: WikiLinkSuggestionItem[] = sorted.map((note) => ({
        id: note.id,
        title: note.title,
        target: note.title,
        alias,
        exists: true,
        type: 'note',
        lastEdited:
          note.modified instanceof Date ? note.modified.toISOString() : note.modified
      }))

      const hasExactMatch = search
        ? filtered.some((note) => note.title.toLowerCase() === search.toLowerCase())
        : true

      if (search && !hasExactMatch) {
        suggestions.push({
          id: `create:${search}`,
          title: search,
          target: search,
          alias,
          exists: false,
          type: 'create'
        })
      }

      return suggestions
    },
    []
  )

  const handleWikiLinkSelect = useCallback(
    (item: WikiLinkSuggestionItem) => {
      if (!item.target) return
      editor.insertInlineContent(
        [createWikiLinkInlineContent(item.target, item.alias ?? '')],
        { updateSelection: true }
      )
      editor.insertInlineContent([' '], { updateSelection: true })
    },
    [editor]
  )

  return { getWikiLinkItems, handleWikiLinkSelect }
}
