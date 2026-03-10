import { useCallback, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { inboxService } from '@/services/inbox-service'
import { inboxKeys } from './use-inbox'
import type { Toast } from '@/components/ui/toast'

const UNDO_WINDOW_MS = 5000

type UndoType = 'archive' | 'file'

interface PendingUndo {
  id: string
  type: UndoType
  title: string
  timer: ReturnType<typeof setTimeout>
}

type AddToast = (toast: Omit<Toast, 'id'>) => void

export interface UseUndoableActionResult {
  archiveWithUndo: (id: string, title: string) => Promise<void>
  fileWithUndo: (id: string, title: string) => Promise<void>
}

export function useUndoableAction(addToast: AddToast): UseUndoableActionResult {
  const queryClient = useQueryClient()
  const pendingRef = useRef<Map<string, PendingUndo>>(new Map())

  const invalidateAll = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: inboxKeys.lists() })
    void queryClient.invalidateQueries({ queryKey: inboxKeys.stats() })
  }, [queryClient])

  const performUndo = useCallback(
    async (key: string) => {
      const pending = pendingRef.current.get(key)
      if (!pending) return

      clearTimeout(pending.timer)
      pendingRef.current.delete(key)

      const result =
        pending.type === 'archive'
          ? await inboxService.undoArchive(pending.id)
          : await inboxService.undoFile(pending.id)

      if (result.success) {
        invalidateAll()
        addToast({ message: `"${pending.title}" restored`, type: 'info' })
      }
    },
    [invalidateAll, addToast]
  )

  const showUndoToast = useCallback(
    (key: string, title: string, verb: string) => {
      addToast({
        message: `${verb} "${title}"`,
        type: 'success',
        duration: UNDO_WINDOW_MS,
        onUndo: () => void performUndo(key)
      })
    },
    [addToast, performUndo]
  )

  const enqueue = useCallback(
    (id: string, title: string, type: UndoType) => {
      const key = `${type}-${id}-${Date.now()}`

      const timer = setTimeout(() => {
        pendingRef.current.delete(key)
      }, UNDO_WINDOW_MS)

      pendingRef.current.set(key, { id, type, title, timer })

      const verb = type === 'archive' ? 'Archived' : 'Filed'
      showUndoToast(key, title, verb)
    },
    [showUndoToast]
  )

  const archiveWithUndo = useCallback(
    async (id: string, title: string) => {
      const result = await inboxService.archive(id)
      if (!result.success) throw new Error(result.error || 'Failed to archive')
      invalidateAll()
      enqueue(id, title, 'archive')
    },
    [invalidateAll, enqueue]
  )

  const fileWithUndo = useCallback(
    async (id: string, title: string) => {
      invalidateAll()
      enqueue(id, title, 'file')
    },
    [invalidateAll, enqueue]
  )

  return { archiveWithUndo, fileWithUndo }
}
