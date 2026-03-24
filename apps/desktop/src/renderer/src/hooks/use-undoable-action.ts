import { useCallback, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { inboxService } from '@/services/inbox-service'
import { inboxKeys } from './use-inbox'

const UNDO_WINDOW_MS = 5000

type UndoType = 'archive' | 'file'

interface PendingUndo {
  id: string
  type: UndoType
  title: string
  timer: ReturnType<typeof setTimeout>
}

export interface UseUndoableActionResult {
  archiveWithUndo: (id: string, title: string) => Promise<void>
  fileWithUndo: (id: string, title: string) => Promise<void>
}

export function useUndoableAction(): UseUndoableActionResult {
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
        toast.info(`"${pending.title}" restored`)
      }
    },
    [invalidateAll]
  )

  const enqueue = useCallback(
    (id: string, title: string, type: UndoType) => {
      const key = `${type}-${id}-${Date.now()}`

      const timer = setTimeout(() => {
        pendingRef.current.delete(key)
      }, UNDO_WINDOW_MS)

      pendingRef.current.set(key, { id, type, title, timer })

      const verb = type === 'archive' ? 'Archived' : 'Filed'
      toast.success(`${verb} "${title}"`, {
        duration: UNDO_WINDOW_MS,
        action: {
          label: 'Undo',
          onClick: () => void performUndo(key)
        }
      })
    },
    [performUndo]
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
