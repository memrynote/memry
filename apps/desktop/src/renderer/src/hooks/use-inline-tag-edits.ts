import { useCallback, useRef } from 'react'
import type { InlineTagsOrigin } from '@/components/note'

/** The `#tags` a body gained and lost. */
export interface InlineTagEdit {
  add: string[]
  remove: string[]
}

/** Two unsaved edits as one: a later add cancels an earlier remove of the same tag, and the reverse. */
export function mergeInlineTagEdits(earlier: InlineTagEdit, later: InlineTagEdit): InlineTagEdit {
  const key = (tag: string): string => tag.toLowerCase()
  const add = new Map(earlier.add.map((tag) => [key(tag), tag]))
  const remove = new Map(earlier.remove.map((tag) => [key(tag), tag]))
  for (const tag of later.add) {
    remove.delete(key(tag))
    add.set(key(tag), tag)
  }
  for (const tag of later.remove) {
    add.delete(key(tag))
    remove.set(key(tag), tag)
  }
  return { add: [...add.values()], remove: [...remove.values()] }
}

/**
 * Turns the editor's inline `#tag` reports into edits. The tags a body opened
 * with only seed the baseline, because opening a note or journal entry must
 * not modify it (#1454); each later report yields what changed since the last.
 */
export function useInlineTagEdits(
  onEdit: (edit: InlineTagEdit) => void
): (currentInlineTags: string[], origin: InlineTagsOrigin) => void {
  const inlineTagsRef = useRef<Set<string>>(new Set())

  return useCallback(
    (currentInlineTags: string[], origin: InlineTagsOrigin) => {
      const prev = inlineTagsRef.current
      const current = new Set(currentInlineTags)
      inlineTagsRef.current = current
      if (origin === 'load') return

      const add = currentInlineTags.filter((tag) => !prev.has(tag))
      const remove = [...prev].filter((tag) => !current.has(tag))
      if (add.length > 0 || remove.length > 0) onEdit({ add, remove })
    },
    [onEdit]
  )
}
