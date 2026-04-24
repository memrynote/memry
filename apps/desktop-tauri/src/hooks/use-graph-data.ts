import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { GraphDataResponse } from '@memry/contracts/graph-api'
import { onNoteCreated, onNoteUpdated, onNoteDeleted } from '@/services/notes-service'
import { onTaskCreated, onTaskUpdated, onTaskDeleted } from '@/services/tasks-service'
import { invoke } from '@/lib/ipc/invoke'

export const graphKeys = {
  all: ['graph'] as const,
  data: () => [...graphKeys.all, 'data'] as const,
  local: (noteId: string) => [...graphKeys.all, 'local', noteId] as const
}

export function useGraphData() {
  return useQuery<GraphDataResponse>({
    queryKey: graphKeys.data(),
    queryFn: () => invoke<GraphDataResponse>('graph_get_data'),
    staleTime: 30_000
  })
}

export function useLocalGraphData(noteId: string | undefined) {
  return useQuery<GraphDataResponse>({
    queryKey: graphKeys.local(noteId ?? ''),
    queryFn: () => invoke<GraphDataResponse>('graph_get_local', { noteId: noteId! }),
    enabled: !!noteId,
    staleTime: 15_000
  })
}

export function useGraphReactivity(): void {
  const queryClient = useQueryClient()

  useEffect(() => {
    const invalidateAll = () => {
      void queryClient.invalidateQueries({ queryKey: graphKeys.all })
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
      for (const unsub of unsubs) unsub()
    }
  }, [queryClient])
}
