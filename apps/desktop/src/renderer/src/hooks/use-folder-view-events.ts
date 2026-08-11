/**
 * Global Event Handler for Folder-View Cache Invalidation
 *
 * This hook must be called once at the app level (App.tsx) to handle note events
 * even when folder-view tabs are unmounted.
 *
 * Problem: When multiple folder-view tabs are open and Tab A moves/deletes a note,
 * Tab B (which is unmounted) doesn't receive the event. When Tab B becomes active,
 * it shows stale cached data.
 *
 * Solution: This global hook is always mounted and invalidates ALL folder-view caches
 * when note events occur. When Tab B becomes active, TanStack Query sees stale data
 * and refetches automatically.
 */

import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  onNoteMoved,
  onNoteDeleted,
  onNoteCreated,
  onNoteUpdated,
  onNoteRenamed,
  onNoteExternalChange
} from '@/services/notes-service'
import { folderViewKeys } from './use-folder-view'

/**
 * How long a burst of `notes:updated` events is coalesced before the folder-view
 * caches are invalidated.
 *
 * `notes:updated` fires on every autosave (the editor debounces at 1s), on every
 * CRDT write-back, and on every watcher-observed file change, so typing with a
 * folder or tag view in a split pane used to refetch the whole listing about
 * once a second. A content update can never change *which* notes a view
 * contains: folder membership moves through `notes:created`/`renamed`/`moved`/
 * `deleted`, and tag membership through the tag events `useFolderView`
 * subscribes to per scope. Only row data (Modified, word count, properties,
 * title, emoji) is at stake, so the burst is coalesced instead of dropped.
 *
 * Trailing edge: the last update in a burst is always the one that invalidates,
 * so no event is lost — the refetch just lands this many ms after typing stops.
 */
const NOTE_UPDATE_INVALIDATE_DELAY_MS = 3000

/**
 * Global event handler for folder-view cache invalidation.
 * Call this once in App.tsx to ensure all folder-view tabs stay in sync.
 */
export function useFolderViewEvents(): void {
  const queryClient = useQueryClient()

  useEffect(() => {
    // Invalidate ALL folder-view caches when notes change
    // This ensures all tabs (mounted or not) get fresh data when activated

    let updateTimer: ReturnType<typeof setTimeout> | null = null

    const invalidate = () => {
      // A structural event invalidates the same key a pending content update
      // would have, and happens after it, so it supersedes the pending refetch.
      if (updateTimer) {
        clearTimeout(updateTimer)
        updateTimer = null
      }
      void queryClient.invalidateQueries({ queryKey: folderViewKeys.all })
    }

    const invalidateAfterUpdateBurst = () => {
      if (updateTimer) clearTimeout(updateTimer)
      updateTimer = setTimeout(invalidate, NOTE_UPDATE_INVALIDATE_DELAY_MS)
    }

    const unsubMoved = onNoteMoved(invalidate)
    const unsubDeleted = onNoteDeleted(invalidate)
    const unsubCreated = onNoteCreated(invalidate)
    const unsubUpdated = onNoteUpdated(invalidateAfterUpdateBurst)
    const unsubRenamed = onNoteRenamed(invalidate)
    const unsubExternal = onNoteExternalChange(invalidate)

    return () => {
      if (updateTimer) clearTimeout(updateTimer)
      unsubMoved()
      unsubDeleted()
      unsubCreated()
      unsubUpdated()
      unsubRenamed()
      unsubExternal()
    }
  }, [queryClient])
}
