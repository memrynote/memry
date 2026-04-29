import { useQuery } from '@tanstack/react-query'
import type { Task } from '@/services/tasks-service'
import { tasksService } from '@/services/tasks-service'

export function useTask(taskId: string | null) {
  return useQuery<Task | null>({
    queryKey: ['task', taskId],
    queryFn: () => tasksService.get(taskId as string),
    enabled: !!taskId
  })
}
