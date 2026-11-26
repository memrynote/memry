/**
 * The `@` / `[[` note picker of a task block's title input (#5294).
 *
 * The note editor's pickers stop at the task row, because the title is a plain
 * `<input>` and not editor content. This brings the same note list to that
 * input: `[[Roa` or `@Roa` offers notes, and picking one writes `[[Roadmap]]`
 * into the title, the form the note line already stores and indexes.
 *
 * `@` also starts a quick-add date (`@tomorrow`, `@fri 3pm`), so a query that
 * reads as a date keeps the date grammar and opens no picker. An `@` query also
 * ends at its first space unless a note title starts with it, so `@home` stays
 * plain text once the sentence moves on.
 */

import { useCallback, useId, useMemo, useState, type KeyboardEvent, type RefObject } from 'react'
import { AutocompleteDropdown } from '@/components/tasks/quick-add/autocomplete-dropdown'
import { useNoteSuggestions } from '@/components/capture-bar/capture-bar-suggestions'
import { fuzzySearch } from '@/lib/fuzzy-search'
import { predictDateCompletion } from '@/lib/date-phrase-completion'
import { findDatePhrase } from '@/lib/quick-add-parser'

/** How many notes the picker shows at once, as in the capture bar. */
const NOTE_PICKER_LIMIT = 10

export interface NoteTrigger {
  /** Index of the `@` or `[[` that opened the picker. */
  start: number
  query: string
}

/**
 * The picker trigger that ends at the caret, given the text before it and the
 * titles of the notes the picker can offer.
 */
export function findNoteTrigger(
  beforeCaret: string,
  noteTitles: readonly string[]
): NoteTrigger | null {
  const link = beforeCaret.lastIndexOf('[[')
  if (link >= 0 && !beforeCaret.slice(link + 2).includes(']]')) {
    return { start: link, query: beforeCaret.slice(link + 2) }
  }
  const at = /(?:^|\s)@([^@[\]\n]*)$/.exec(beforeCaret)
  if (!at) return null
  const query = at[1]
  if (query.startsWith(' ') || predictDateCompletion(query) !== null) return null
  // A date the quick-add grammar would read (`@fri 3pm`) stays a date.
  if (findDatePhrase(`@${query}`)?.end === query.length + 1) return null
  if (/\s/.test(query)) {
    const typed = query.toLowerCase()
    if (!noteTitles.some((title) => title.toLowerCase().startsWith(typed))) return null
  }
  return { start: beforeCaret.length - query.length - 1, query }
}

export interface TitleNotePicker {
  /** The dropdown, or null while closed. Render it inside a `relative` box. */
  picker: React.ReactNode
  /**
   * Combobox attributes for the input. `aria-expanded` also tells the global
   * Escape handler (use-hint-activation) to leave the field focused, so Esc
   * closes the list instead of blurring and committing a half-typed `@Ro`.
   */
  inputProps: {
    role: 'combobox'
    'aria-expanded': boolean
    'aria-controls': string | undefined
    'aria-autocomplete': 'list'
  }
  /** Runs before the input's own key handler; true when the picker took the key. */
  handleKeyDown: (e: KeyboardEvent<HTMLInputElement>) => boolean
  /** Call on every change, click and key-up so the trigger follows the caret. */
  trackCaret: (input: HTMLInputElement) => void
}

export function useTitleNotePicker(
  value: string,
  inputRef: RefObject<HTMLInputElement | null>,
  onChange: (value: string) => void
): TitleNotePicker {
  // The focus effect puts the caret at the end, so that is where it starts.
  const [caret, setCaret] = useState<number | null>(null)
  const [dismissedAt, setDismissedAt] = useState<string | null>(null)
  const [index, setIndex] = useState(0)

  const listId = useId()

  const end = Math.min(caret ?? value.length, value.length)
  const [notesWanted, setNotesWanted] = useState(false)
  const notes = useNoteSuggestions(notesWanted)
  const titles = useMemo(() => notes.map((note) => note.title), [notes])
  const trigger = useMemo(() => findNoteTrigger(value.slice(0, end), titles), [value, end, titles])
  if (trigger !== null && !notesWanted) setNotesWanted(true)

  const options = useMemo(() => {
    if (!trigger) return []
    const query = trigger.query.trim()
    const matched = query ? fuzzySearch(notes, query, ['title']) : notes
    return matched
      .slice(0, NOTE_PICKER_LIMIT)
      .map((note) => ({ value: note.id, label: note.title }))
  }, [trigger, notes])

  // Reset the highlight whenever the list changes underneath it.
  const [lastOptions, setLastOptions] = useState(options)
  if (lastOptions !== options) {
    setLastOptions(options)
    setIndex(0)
  }

  // Esc closes the list for this text; the next keystroke re-arms it.
  const isOpen = trigger !== null && dismissedAt !== value && options.length > 0

  const select = useCallback(
    (noteId: string): void => {
      const note = notes.find((candidate) => candidate.id === noteId)
      if (!note || !trigger) return
      const head = `${value.slice(0, trigger.start)}[[${note.title}]] `
      onChange(`${head}${value.slice(end).trimStart()}`)
      setCaret(head.length)
      requestAnimationFrame(() => inputRef.current?.setSelectionRange(head.length, head.length))
    },
    [notes, trigger, value, end, onChange, inputRef]
  )

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>): boolean => {
      if (!isOpen) return false
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const step = e.key === 'ArrowDown' ? 1 : -1
        setIndex((prev) => Math.min(Math.max(prev + step, 0), options.length - 1))
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        select(options[index].value)
      } else if (e.key === 'Escape') {
        setDismissedAt(value)
      } else {
        return false
      }
      e.preventDefault()
      e.stopPropagation()
      return true
    },
    [isOpen, options, index, select, value]
  )

  const trackCaret = useCallback((input: HTMLInputElement): void => {
    setCaret(input.selectionStart)
  }, [])

  const picker = isOpen ? (
    <AutocompleteDropdown
      id={listId}
      type="note"
      options={options}
      selectedIndex={index}
      onSelect={select}
      onClose={() => setDismissedAt(value)}
    />
  ) : null

  const inputProps = {
    role: 'combobox',
    'aria-expanded': isOpen,
    'aria-controls': isOpen ? listId : undefined,
    'aria-autocomplete': 'list'
  } as const

  return { picker, inputProps, handleKeyDown, trackCaret }
}
