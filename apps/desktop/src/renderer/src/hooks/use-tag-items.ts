/**
 * Fetches every note/task/inbox item carrying a given tag (Task 15's
 * `tags:list-items` backend) and adapts each into a `NoteWithProperties`
 * row so the tag page can render them through the shared `FolderTableView`
 * (Task 16's `kind` column).
 */
import { useCallback, useEffect, useState } from 'react'
import { getI18n } from 'react-i18next'
import { createLogger } from '@/lib/logger'
import { extractErrorMessage } from '@/lib/ipc-error'
import { tagsService, onTagNotesChanged, type TagItem } from '@/services/tags-service'
import { onTagsChanged } from '@/services/notes-service'
import type { NoteWithProperties } from '@memry/contracts/folder-view-api'

const log = createLogger('Hook:TagItems')

export interface UseTagItemsOptions {
  tag: string
}

export interface UseTagItemsResult {
  items: NoteWithProperties[]
  total: number
  isLoading: boolean
  error: string | null
  refresh: () => Promise<void>
}

/**
 * Adapt a `TagItem` (note | task | inbox) into the table row shape.
 * - `path`: the note's real path for notes; a synthetic `/tasks/<id>` or
 *   `/inbox/<id>` for tasks/inbox, which have no note path of their own.
 * - `folder`: carries `container` (the note's parent folder, or the task's
 *   project name — inbox items have no container).
 * - `wordCount`: always 0 — `TagItem` never carries a word count for any kind.
 */
function adaptTagItem(item: TagItem): NoteWithProperties {
  const path =
    item.kind === 'note'
      ? (item.path ?? '')
      : item.kind === 'task'
        ? `/tasks/${item.id}`
        : `/inbox/${item.id}`

  return {
    id: item.id,
    path,
    title: item.title,
    emoji: item.emoji,
    folder: item.container ?? '',
    tags: item.tags,
    created: item.created,
    modified: item.modified,
    wordCount: 0,
    properties: {},
    kind: item.kind
  }
}

export function useTagItems({ tag }: UseTagItemsOptions): UseTagItemsResult {
  const [items, setItems] = useState<NoteWithProperties[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchItems = useCallback(async () => {
    // `useTagItems` runs outside any component tree that already resolved a
    // fixed namespace (unlike `useTagDetail`'s host component), so it reuses
    // the same key that hook falls back to for the same class of failure.
    const tSettings = getI18n().getFixedT(null, 'settings')
    const fallback = tSettings('phaseI.errors.failedToLoadNotes')

    setIsLoading(true)
    setError(null)
    try {
      const response = await tagsService.listItems(tag)
      if (!response.success) {
        setItems([])
        setError(response.error ?? fallback)
        return
      }
      setItems((response.items ?? []).map(adaptTagItem))
    } catch (err) {
      log.error('Failed to load tag items', err)
      setItems([])
      setError(extractErrorMessage(err, fallback))
    } finally {
      setIsLoading(false)
    }
  }, [tag])

  useEffect(() => {
    void fetchItems()
  }, [fetchItems])

  // Pin/unpin, tag add/remove on a note, task/inbox tag changes — all fire
  // `tags:notes-changed` for this tag.
  useEffect(() => {
    const unsubscribe = onTagNotesChanged((event) => {
      if (event.tag.toLowerCase() === tag.toLowerCase()) {
        void fetchItems()
      }
    })
    return unsubscribe
  }, [tag, fetchItems])

  // Generic "some note's tags changed" signal (e.g. inline tag editing) —
  // no tag is carried on the event, so refetch unconditionally.
  useEffect(() => {
    const unsubscribe = onTagsChanged(() => {
      void fetchItems()
    })
    return unsubscribe
  }, [fetchItems])

  return {
    items,
    total: items.length,
    isLoading,
    error,
    refresh: fetchItems
  }
}

export default useTagItems
