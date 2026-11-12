/**
 * The one owner of the events that refresh the tag list, the folder list and the tag categories.
 *
 * Call it once in App.tsx. The hooks that read these lists (`useNoteTagsQuery`,
 * `useNoteFoldersQuery`, `useTagCategories`) mount once per task row, widget or panel, and a
 * subscription inside each made every mount read the list again once its listener went live
 * (#4270), which defeats `METADATA_STALE_TIME`. Here the listeners go live once and invalidate
 * the cache keys, so every mounted reader reads once.
 */

import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  onFolderConfigUpdated,
  onNoteCreated,
  onNoteDeleted,
  onNoteMoved,
  onNoteRenamed,
  onTagsChanged
} from '@/services/notes-service'
import { onTagCategoriesChanged } from '@/services/tags-service'
import { subscribeToEvents } from '@/services/tauri-event'
import { notesKeys, rereadQueries } from './use-notes-query'

export function useNoteMetadataEvents(): void {
  const queryClient = useQueryClient()

  useEffect(() => {
    // A list's first read may still be out when its change lands: `rereadQueries` makes the
    // re-read a new read instead of folding it into the one that began before the change.
    const invalidateTags = () => rereadQueries(queryClient, notesKeys.tags())
    const invalidateFolders = () => rereadQueries(queryClient, notesKeys.folders())
    // The category rows and the tags' `categoryId` change together: a drag that moves a tag
    // between categories must show without waiting for an unrelated tag event.
    const invalidateCategories = () => {
      rereadQueries(queryClient, notesKeys.tagCategories())
      invalidateTags()
    }

    // A change before a listener went live sent its event to nobody: read again once it is.
    const unsubTags = subscribeToEvents(
      [
        (live) => onTagsChanged(invalidateTags, live),
        (live) => onTagCategoriesChanged(invalidateCategories, live)
      ],
      invalidateCategories
    )
    const unsubFolders = subscribeToEvents(
      [
        (live) => onNoteCreated(invalidateFolders, live),
        (live) => onNoteDeleted(invalidateFolders, live),
        (live) => onNoteMoved(invalidateFolders, live),
        (live) => onNoteRenamed(invalidateFolders, live),
        (live) => onFolderConfigUpdated(invalidateFolders, live)
      ],
      invalidateFolders
    )

    return () => {
      unsubTags()
      unsubFolders()
    }
  }, [queryClient])
}
