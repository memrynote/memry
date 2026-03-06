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
 * Global event handler for folder-view cache invalidation.
 * Call this once in App.tsx to ensure all folder-view tabs stay in sync.
 */
export function useFolderViewEvents(): void {
  const queryClient = useQueryClient()

  useEffect(() => {
    // Invalidate ALL folder-view caches when notes change
    // This ensures all tabs (mounted or not) get fresh data when activated

    const invalidate = () => {
      void queryClient.invalidateQueries({ queryKey: folderViewKeys.all })
    }

    const unsubMoved = onNoteMoved(invalidate)
    const unsubDeleted = onNoteDeleted(invalidate)
    const unsubCreated = onNoteCreated(invalidate)
    const unsubUpdated = onNoteUpdated(invalidate)
    const unsubRenamed = onNoteRenamed(invalidate)
    const unsubExternal = onNoteExternalChange(invalidate)

    return () => {
      unsubMoved()
      unsubDeleted()
      unsubCreated()
      unsubUpdated()
      unsubRenamed()
      unsubExternal()
    }
  }, [queryClient])
}
