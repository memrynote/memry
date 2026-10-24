import { useMemo } from 'react'

import { useNotesList } from '@/hooks/use-notes-query'
import { NOTE_TREE_PAGE_SIZE } from '@/hooks/use-note-tree-data'
import { buildTaskNoteIndex, type TaskNoteIndex } from '@/lib/task-note-index'

/**
 * Note id -> title/folder lookup for the folder and note grouping modes.
 *
 * The query options match the sidebar tree's first page exactly, so the two
 * share one TanStack cache entry and the common case costs no extra IPC. It
 * stays disabled until a caller actually groups by folder or note: a vault with
 * thousands of notes should not pay for this list because the Tasks page is
 * open.
 *
 * Returns `undefined` while there is nothing to answer with, which callers read
 * as "do not group yet" rather than "nothing is filed".
 */
export const useTaskNoteIndex = (enabled: boolean): TaskNoteIndex | undefined => {
  const { notes, isLoading } = useNotesList({
    limit: NOTE_TREE_PAGE_SIZE,
    fields: 'tree',
    enabled
  })

  return useMemo(() => {
    if (!enabled || isLoading) return undefined
    return buildTaskNoteIndex(notes)
  }, [enabled, isLoading, notes])
}
