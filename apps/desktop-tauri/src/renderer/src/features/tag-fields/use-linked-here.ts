import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { LinkedHereGroup } from '@memry/contracts/tag-objects-api'
import { tagsService } from '@/services/tags-service'
import { onNoteLinksChanged, onNoteUpdated, onTagsChanged } from '@/services/notes-service'
import { onTaskUpdated } from '@/services/tasks-service'
import { subscribeToEvents } from '@/services/tauri-event'
import { rereadQueries } from '@/hooks/use-notes-query'

export const linkedHereKey = (noteId: string, limit: number) =>
  ['tags', 'linked-here', noteId, limit] as const

const INVALIDATE_DELAY_MS = 250

export function useLinkedHere(
  noteId: string,
  limitPerGroup: number
): { groups: LinkedHereGroup[]; isLoading: boolean } {
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: linkedHereKey(noteId, limitPerGroup),
    queryFn: async () => (await tagsService.getLinkedHere({ noteId, limitPerGroup })).groups
  })

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const invalidate = (): void => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        rereadQueries(queryClient, ['tags', 'linked-here', noteId])
      }, INVALIDATE_DELAY_MS)
    }
    const offs = [
      // The groups were read before these listeners went live, and a change in between sent its
      // event to nobody: read them again once they listen.
      subscribeToEvents(
        [
          (live) => onNoteUpdated(invalidate, live),
          (live) => onTagsChanged(invalidate, live),
          // A note's update comes before the index pass that writes its links and relation
          // values; this comes once they are committed.
          (live) =>
            onNoteLinksChanged(({ targetIds }) => {
              if (targetIds.includes(noteId)) invalidate()
            }, live)
        ],
        invalidate
      ),
      onTaskUpdated(invalidate)
    ]
    return () => {
      if (timer) clearTimeout(timer)
      offs.forEach((off) => off())
    }
  }, [noteId, queryClient])

  return { groups: query.data ?? [], isLoading: query.isLoading }
}
