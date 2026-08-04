import { useCallback, useEffect, useState } from 'react'
import { tasksService, onProjectUpdated, type ProjectWithStats } from '@/services/tasks-service'
import { extractErrorMessage } from '@/lib/ipc-error'
import { createLogger } from '@/lib/logger'

const log = createLogger('Hook:ProjectsList')

export interface UseProjectsListReturn {
  projects: ProjectWithStats[]
  isLoading: boolean
}

/**
 * All projects (including archived), refreshed whenever a project changes.
 * Archived projects are kept here so a note already naming one can still
 * resolve it by name to its real color/icon — callers that populate a
 * picker of addable projects must filter `archivedAt == null` themselves.
 */
export function useProjectsList(): UseProjectsListReturn {
  const [projects, setProjects] = useState<ProjectWithStats[]>([])
  const [isLoading, setIsLoading] = useState(true)

  const load = useCallback(async (): Promise<void> => {
    try {
      const result = await tasksService.listProjects()
      setProjects(result.projects)
    } catch (error) {
      log.error('Failed to list projects', extractErrorMessage(error))
      setProjects([])
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => onProjectUpdated(() => void load()), [load])

  return { projects, isLoading }
}
