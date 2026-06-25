/* eslint-disable @typescript-eslint/no-explicit-any */

import { useCallback, useRef, useState } from 'react'
import { fuzzySearch } from '@/lib/fuzzy-search'
import { notesService } from '@/services/notes-service'
import { createWikiLinkInlineContent } from '../wiki-link'
import { buildDateMentionEntry, predictTime } from '../date-suggestions'
import type { DateMentionValue } from '../date-mention-popover'
import type { MentionSuggestionItem } from '../mention-menu'
import { createLogger } from '@/lib/logger'

const log = createLogger('Hook:MentionSuggestions')

const COLLAPSED_LIMIT = 10

type NoteSuggestion = {
  id: string
  title: string
  modified?: Date | string
}

interface UseMentionSuggestionsOptions {
  onInsertDate: (value: DateMentionValue) => void
}

export function useMentionSuggestions(editor: any, { onInsertDate }: UseMentionSuggestionsOptions) {
  const notesCacheRef = useRef<{ notes: NoteSuggestion[]; fetchedAt: number } | null>(null)
  // Live `@` query, so a date-hint selection can restore the text BlockNote
  // strips on item select (see handleMentionSelect).
  const lastQueryRef = useRef('')
  const [expanded, setExpanded] = useState(false)
  const [mentionHasMore, setMentionHasMore] = useState(false)

  // getMentionItems MUST be memoized on `expanded`: BlockNote's items hook
  // re-runs getItems whenever its identity changes, which is how "Show more"
  // (flipping `expanded`) reveals the full list. An unmemoized identity would
  // loop forever against the setMentionHasMore call below.
  const getMentionItems = useCallback(
    async (query: string): Promise<MentionSuggestionItem[]> => {
      lastQueryRef.current = query
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
          log.error('Failed to load mention suggestions', error)
          notesCacheRef.current = { notes: [], fetchedAt: now }
        }
      }

      const notes = notesCacheRef.current?.notes ?? []
      const trimmed = query.trim()
      const filtered = trimmed ? fuzzySearch(notes, trimmed, ['title']) : notes
      const visible = expanded ? filtered : filtered.slice(0, COLLAPSED_LIMIT)
      setMentionHasMore(!expanded && filtered.length > COLLAPSED_LIMIT)

      const noteItems: MentionSuggestionItem[] = visible.map((note) => ({
        kind: 'note',
        id: note.id,
        title: note.title,
        lastEdited: note.modified instanceof Date ? note.modified.toISOString() : note.modified
      }))

      // Date group: a full date+remind pair when any leading prefix parses
      // (empty query → today), or a non-selectable hint row that keeps the menu
      // open while a date-ish phrase is still being typed (e.g. "next monday").
      // A non-date query (e.g. "@meeting note") yields note results only.
      const { suggestion, hint } = buildDateMentionEntry(trimmed)
      // While a time is being typed (bare "12" → ghost ":00", or after a date:
      // "today 12" → ":00"), yield no items so the `@` menu closes and Tab is owned
      // by the inline ghost (which fills the time) instead of committing a no-time
      // date pill via this menu. Narrow to time-in-progress only: empty queries,
      // partial dates ("next"), and note searches still get their normal items.
      if (predictTime(trimmed) !== null) return []

      const dateItems: MentionSuggestionItem[] = suggestion
        ? [
            { kind: 'date', label: suggestion.dateLabel, value: suggestion.dateValue },
            { kind: 'remind', subtitle: suggestion.remindSubtitle, value: suggestion.remindValue }
          ]
        : hint
          ? [{ kind: 'date-hint' }]
          : []

      return [...dateItems, ...noteItems]
    },
    [expanded]
  )

  const showMore = useCallback(() => setExpanded(true), [])

  const handleMentionSelect = useCallback(
    (item: MentionSuggestionItem): void => {
      if (item.kind === 'date-hint') {
        // BlockNote strips the typed `@query` whenever any item is selected,
        // including this non-actionable hint. Re-insert it so pressing Enter
        // while a date phrase is still mid-type doesn't silently delete the
        // user's text. (Empty query, e.g. a direct unit call → nothing to do.)
        const query = lastQueryRef.current
        if (query) editor.insertInlineContent('@' + query)
        return
      }
      if (item.kind === 'note') {
        editor.insertInlineContent([createWikiLinkInlineContent(item.title, ''), ' '], {
          updateSelection: true
        })
      } else {
        onInsertDate(item.value)
      }
      setExpanded(false)
    },
    [editor, onInsertDate]
  )

  return { getMentionItems, handleMentionSelect, mentionHasMore, showMore }
}
