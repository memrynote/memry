/**
 * The `@` / `[[` note picker of a task block's title input (#5294).
 *
 * The note editor's pickers stop at the task row, because the title is a plain
 * `<input>` and not editor content. This brings the same note list to that
 * input: `[[Roa` or `@Roa` offers notes, and picking one writes `[[Roadmap]]`
 * into the title, the form the note line already stores and indexes.
 *
 * `@` also starts a quick-add date (`@tomorrow`), so a query that reads as a
 * date keeps the date grammar and opens no picker.
 */

import { useCallback, useMemo, useState, type KeyboardEvent, type RefObject } from 'react'
import { AutocompleteDropdown } from '@/components/tasks/quick-add/autocomplete-dropdown'
import { useNoteSuggestions } from '@/components/capture-bar/capture-bar-suggestions'
import { fuzzySearch } from '@/lib/fuzzy-search'
import { predictDateCompletion } from '@/lib/date-phrase-completion'

/** How many notes the picker shows at once, as in the capture bar. */
const NOTE_PICKER_LIMIT = 10

export interface NoteTrigger {
  /** Index of the `@` or `[[` that opened the picker. */
  start: number
  query: string
}

/** The picker trigger that ends at the caret, given the text before it. */
export function findNoteTrigger(beforeCaret: string): NoteTrigger | null {
  const link = beforeCaret.lastIndexOf('[[')
  if (link >= 0 && !beforeCaret.slice(link + 2).includes(']]')) {
    return { start: link, query: beforeCaret.slice(link + 2) }
  }
  const at = /(?:^|\s)@([^@[\]\n]*)$/.exec(beforeCaret)
  if (!at) return null
  const query = at[1]
  if (query.startsWith(' ') || predictDateCompletion(query) !== null) return null
  return { start: beforeCaret.length - query.length - 1, query }
}

export interface TitleNotePicker {
  /** The dropdown, or null while closed. Render it inside a `relative` box. */
  picker: React.ReactNode
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

  const end = Math.min(caret ?? value.length, value.length)
  const trigger = useMemo(() => findNoteTrigger(value.slice(0, end)), [value, end])
  const notes = useNoteSuggestions(trigger !== null)

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
      type="note"
      options={options}
      selectedIndex={index}
      onSelect={select}
      onClose={() => setDismissedAt(value)}
    />
  ) : null

  return { picker, handleKeyDown, trackCaret }
}
