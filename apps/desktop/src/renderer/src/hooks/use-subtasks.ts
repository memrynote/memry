import { useQuery } from '@tanstack/react-query'
import type { Task } from '@/services/tasks-service'
import { tasksService } from '@/services/tasks-service'

export function useSubtasks(parentId: string | null) {
  return useQuery<Task[]>({
    queryKey: ['subtasks', parentId],
    queryFn: () => tasksService.getSubtasks(parentId as string),
    enabled: !!parentId
  })
}
