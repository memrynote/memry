import { useCallback, useRef } from 'react'
import type { InlineTagsOrigin } from '@/components/note'

/**
 * The entry's tag list after the body's inline `#tags` changed from `prev` to
 * `current`, or null when nothing needs writing. A tag the row already holds is
 * not added twice, and only a tag the body used to carry is removed from it.
 */
export function diffInlineTags(
  entryTags: string[],
  prev: Set<string>,
  current: string[]
): string[] | null {
  const currentSet = new Set(current)
  const tagsToAdd = current.filter((t) => !prev.has(t) && !entryTags.includes(t))
  const tagsToRemove = Array.from(prev).filter((t) => !currentSet.has(t) && entryTags.includes(t))
  if (tagsToAdd.length === 0 && tagsToRemove.length === 0) return null
  return [...entryTags.filter((t) => !tagsToRemove.includes(t)), ...tagsToAdd]
}

/**
 * Inline #tag sync for a journal entry, as on the note page: the body's tags
 * seed a baseline on open and only a typed change is written to the entry's
 * tag list. Opening an entry must not modify it (#1454).
 */
export function useJournalInlineTags(
  entryTags: string[],
  updateTags: (tags: string[]) => void
): (currentInlineTags: string[], origin: InlineTagsOrigin) => void {
  const inlineTagsRef = useRef<Set<string>>(new Set())

  return useCallback(
    (currentInlineTags: string[], origin: InlineTagsOrigin) => {
      const prev = inlineTagsRef.current
      inlineTagsRef.current = new Set(currentInlineTags)
      if (origin === 'load') return

      const next = diffInlineTags(entryTags, prev, currentInlineTags)
      if (next) updateTags(next)
    },
    [entryTags, updateTags]
  )
}
