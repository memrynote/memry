import { useQuery } from '@tanstack/react-query'
import type { Task } from '@/services/tasks-service'
import { tasksService } from '@/services/tasks-service'

export function useTask(taskId: string | null) {
  return useQuery<Task | null>({
    queryKey: ['task', taskId],
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- queryFn only runs when enabled, which requires a truthy id
    queryFn: () => tasksService.get(taskId as string),
    enabled: !!taskId
  })
}
