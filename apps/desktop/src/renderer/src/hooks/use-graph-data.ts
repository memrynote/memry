import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { GraphDataResponse } from '@memry/contracts/graph-api'
import { onNoteCreated, onNoteUpdated, onNoteDeleted } from '@/services/notes-service'
import { onTaskCreated, onTaskUpdated, onTaskDeleted } from '@/services/tasks-service'

export const graphKeys = {
  all: ['graph'] as const,
  data: () => [...graphKeys.all, 'data'] as const,
  local: (noteId: string) => [...graphKeys.all, 'local', noteId] as const
}

export function useGraphData() {
  return useQuery<GraphDataResponse>({
    queryKey: graphKeys.data(),
    queryFn: () => window.api.graph.getData(),
    staleTime: 30_000
  })
}

export function useLocalGraphData(noteId: string | undefined) {
  return useQuery<GraphDataResponse>({
    queryKey: graphKeys.local(noteId ?? ''),
    queryFn: () => window.api.graph.getLocal({ noteId: noteId! }),
    enabled: !!noteId,
    staleTime: 15_000
  })
}

/**
 * One save can fire several of these events (the note plus each task it owns),
 * and each refetch rebuilds the whole graph in the main process. Coalesce them.
 */
const GRAPH_INVALIDATE_DEBOUNCE_MS = 250

export function useGraphReactivity(): void {
  const queryClient = useQueryClient()

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null

    const invalidateAll = () => {
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        void queryClient.invalidateQueries({ queryKey: graphKeys.all })
      }, GRAPH_INVALIDATE_DEBOUNCE_MS)
    }

    const unsubs = [
      onNoteCreated(invalidateAll),
      onNoteUpdated(invalidateAll),
      onNoteDeleted(invalidateAll),
      onTaskCreated(invalidateAll),
      onTaskUpdated(invalidateAll),
      onTaskDeleted(invalidateAll)
    ]

    return () => {
      if (timer !== null) clearTimeout(timer)
      for (const unsub of unsubs) unsub()
    }
  }, [queryClient])
}
