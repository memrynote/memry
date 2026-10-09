import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { LinkedHereGroup } from '@memry/contracts/tag-objects-api'
import { tagsService } from '@/services/tags-service'
import { onNoteUpdated, onTagsChanged } from '@/services/notes-service'
import { onTaskUpdated } from '@/services/tasks-service'

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
        void queryClient.invalidateQueries({ queryKey: ['tags', 'linked-here', noteId] })
      }, INVALIDATE_DELAY_MS)
    }
    const offs = [onNoteUpdated(invalidate), onTagsChanged(invalidate), onTaskUpdated(invalidate)]
    return () => {
      if (timer) clearTimeout(timer)
      offs.forEach((off) => off())
    }
  }, [noteId, queryClient])

  return { groups: query.data ?? [], isLoading: query.isLoading }
}
