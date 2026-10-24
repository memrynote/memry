import { useQuery } from '@tanstack/react-query'
import { tasksService, type Project } from '@/services/tasks-service'

export function useProject(projectId: string | null) {
  return useQuery<Project | null>({
    queryKey: ['project', projectId],
    queryFn: async () => {
      const { projects } = await tasksService.listProjects()
      return projects.find((p) => p.id === projectId) ?? null
    },
    enabled: !!projectId,
    staleTime: 30_000
  })
}
