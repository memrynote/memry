/* eslint-disable @typescript-eslint/no-explicit-any */

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { fuzzySearch } from '@/lib/fuzzy-search'
import { listTitledCanvases } from '@/lib/canvas-lookup'
import { notesService } from '@/services/notes-service'
import { createWikiLinkInlineContent } from '../wiki-link'
import {
  buildDateMentionEntry,
  buildNowMentionValue,
  isNowQuery,
  predictTime
} from '../date-suggestions'
import type { DateMentionValue } from '../date-mention-popover'
import {
  CANVAS_CHOICE_OPTIONS,
  type CanvasChoiceOption,
  type CanvasChoiceState,
  type MentionSuggestionItem
} from '../mention-menu'
import { blockHasContent } from './use-wiki-link-suggestions'
import { createLogger } from '@/lib/logger'

const log = createLogger('Hook:MentionSuggestions')

const COLLAPSED_LIMIT = 10
// Canvases trail the notes as a short group: `@` is mostly a note picker, and a
// long canvas list would push the notes a query matched out of view.
const COLLAPSED_CANVAS_LIMIT = 3

const MODIFIER_KEYS: Record<string, true> = {
  Shift: true,
  Control: true,
  Alt: true,
  Meta: true,
  CapsLock: true
}

type NoteSuggestion = {
  id: string
  title: string
  modified?: Date | string
}

export interface UseMentionSuggestionsOptions {
  onInsertDate: (value: DateMentionValue) => void
  /** Positions the canvas Mention / Embed popover and scopes its keyboard. */
  editorContainerRef: RefObject<HTMLDivElement | null>
  /** The spatialCanvas flag: off, the `@` menu offers no canvases at all. */
  canvasesEnabled: boolean
}

/** Caret position relative to the editor container, where the choice popover opens. */
function caretPosition(editor: any, container: HTMLElement | null): { x: number; y: number } {
  const view = editor?._tiptapEditor?.view
  if (!view || !container) return { x: 0, y: 0 }
  const coords = view.coordsAtPos(view.state.selection.from)
  const rect = container.getBoundingClientRect()
  return { x: coords.left - rect.left, y: coords.bottom - rect.top + 4 }
}

export function useMentionSuggestions(
  editor: any,
  { onInsertDate, editorContainerRef, canvasesEnabled }: UseMentionSuggestionsOptions
) {
  const notesCacheRef = useRef<{ notes: NoteSuggestion[]; fetchedAt: number } | null>(null)
  // Live `@` query, so a date-hint selection can restore the text BlockNote
  // strips on item select (see handleMentionSelect).
  const lastQueryRef = useRef('')
  const [expanded, setExpanded] = useState(false)
  const [mentionHasMore, setMentionHasMore] = useState(false)
  const [canvasChoice, setCanvasChoice] = useState<CanvasChoiceState | null>(null)
  // Mirrors canvasChoice for the DOM listeners, and is cleared synchronously on
  // commit so a key and a click landing together cannot insert twice.
  const canvasChoiceRef = useRef<CanvasChoiceState | null>(null)

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

      // Note-owned canvases are listed too: owning only hides a canvas from the
      // sidebar tree, it stays mentionable and embeddable from any note.
      // Untitled canvases are left out — a mention has no title to carry.
      const canvases = canvasesEnabled ? await listTitledCanvases() : []
      const filteredCanvases = trimmed ? fuzzySearch(canvases, trimmed, ['title']) : canvases
      const visibleCanvases = expanded
        ? filteredCanvases
        : filteredCanvases.slice(0, COLLAPSED_CANVAS_LIMIT)

      setMentionHasMore(
        !expanded &&
          (filtered.length > COLLAPSED_LIMIT || filteredCanvases.length > COLLAPSED_CANVAS_LIMIT)
      )

      const noteItems: MentionSuggestionItem[] = visible.map((note) => ({
        kind: 'note',
        id: note.id,
        title: note.title,
        lastEdited: note.modified instanceof Date ? note.modified.toISOString() : note.modified
      }))
      const canvasItems: MentionSuggestionItem[] = visibleCanvases.map((canvas) => ({
        kind: 'canvas',
        id: canvas.id,
        title: canvas.title
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
      // `@now` / `@no` lead the Date group with "Now" (today + current time).
      if (isNowQuery(trimmed)) dateItems.unshift({ kind: 'now' })

      return [...dateItems, ...noteItems, ...canvasItems]
    },
    [expanded, canvasesEnabled]
  )

  const showMore = useCallback(() => setExpanded(true), [])

  const openCanvasChoice = useCallback((next: CanvasChoiceState | null) => {
    canvasChoiceRef.current = next
    setCanvasChoice(next)
  }, [])

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
      } else if (item.kind === 'canvas') {
        // BlockNote has already removed the `@query`, so the caret sits where
        // the pick will land. Nothing is inserted until the user chooses.
        openCanvasChoice({
          canvas: { id: item.id, title: item.title },
          position: caretPosition(editor, editorContainerRef.current),
          selectedIndex: 0
        })
      } else if (item.kind === 'now') {
        onInsertDate(buildNowMentionValue())
      } else {
        onInsertDate(item.value)
      }
      setExpanded(false)
    },
    [editor, onInsertDate, openCanvasChoice, editorContainerRef]
  )

  const selectCanvasChoice = useCallback(
    (option: CanvasChoiceOption): void => {
      const choice = canvasChoiceRef.current
      if (!choice) return
      openCanvasChoice(null)

      const { id, title } = choice.canvas
      const block = option === 'embed' ? editor.getTextCursorPosition?.()?.block : null
      if (!block) {
        // The same wiki-link the `[[` menu writes for a canvas.
        editor.insertInlineContent([createWikiLinkInlineContent(title, ''), ' '], {
          updateSelection: true
        })
        return
      }

      const whiteboard = { type: 'whiteboard', props: { canvasId: id } }
      // Only a text block left empty by the stripped `@query` is replaced; a
      // table (non-array content) or a line with other text keeps its content
      // and gets the board after it.
      const boardId: string =
        Array.isArray(block.content) && !blockHasContent(block)
          ? editor.updateBlock(block, whiteboard).id
          : editor.insertBlocks([whiteboard], block, 'after')[0].id

      // The board is not a text block: a caret left on it becomes a text
      // selection across its header and pops the formatting toolbar. Land on
      // the line after it instead, as `/whiteboard` does.
      const next = editor.getNextBlock(boardId)
      const landing =
        next && Array.isArray(next.content)
          ? next
          : editor.insertBlocks([{ type: 'paragraph' }], boardId, 'after')[0]
      editor.setTextCursorPosition(landing, 'start')
    },
    [editor, openCanvasChoice]
  )

  // Keyboard for the open choice, on the editor container in capture phase so
  // it runs ahead of ProseMirror (the caret never leaves the editor). Every way
  // out of the popover short of picking Embed keeps the Mention: Escape, a
  // click elsewhere, or simply typing on. The pick itself is never lost, and
  // since Mention is what a note pick does too, dismissing reads as "the
  // default". A typed key is let through after the mention lands.
  const isChoiceOpen = canvasChoice !== null
  useEffect(() => {
    const container = editorContainerRef.current
    if (!isChoiceOpen || !container) return

    const handleKeyDown = (e: KeyboardEvent): void => {
      const choice = canvasChoiceRef.current
      if (!choice || MODIFIER_KEYS[e.key]) return

      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        e.stopImmediatePropagation()
        const step = e.key === 'ArrowDown' ? 1 : -1
        const count = CANVAS_CHOICE_OPTIONS.length
        openCanvasChoice({
          ...choice,
          selectedIndex: (choice.selectedIndex + step + count) % count
        })
        return
      }

      if (e.key === 'Enter' || e.key === 'Tab' || e.key === 'Escape') {
        e.preventDefault()
        e.stopImmediatePropagation()
        selectCanvasChoice(
          e.key === 'Escape' ? 'mention' : CANVAS_CHOICE_OPTIONS[choice.selectedIndex]
        )
        return
      }

      selectCanvasChoice('mention')
    }

    // mousedown, not click: it lands before the press moves the caret, so the
    // mention goes where the `@` was rather than where the user clicked.
    const handleClickAway = (e: MouseEvent): void => {
      const target = e.target as HTMLElement | null
      if (target?.closest('[data-inline-choice-menu]')) return
      selectCanvasChoice('mention')
    }

    container.addEventListener('keydown', handleKeyDown, { capture: true })
    document.addEventListener('mousedown', handleClickAway, { capture: true })
    return () => {
      container.removeEventListener('keydown', handleKeyDown, { capture: true })
      document.removeEventListener('mousedown', handleClickAway, { capture: true })
    }
  }, [isChoiceOpen, editorContainerRef, openCanvasChoice, selectCanvasChoice])

  return {
    getMentionItems,
    handleMentionSelect,
    mentionHasMore,
    showMore,
    canvasChoice,
    selectCanvasChoice
  }
}
