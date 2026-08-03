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
 * All non-archived projects, refreshed whenever a project changes. Archived
 * projects are excluded from the picker but a note already naming one still
 * renders it — resolution happens by name in the editor, not here.
 */
export function useProjectsList(): UseProjectsListReturn {
  const [projects, setProjects] = useState<ProjectWithStats[]>([])
  const [isLoading, setIsLoading] = useState(true)

  const load = useCallback(async (): Promise<void> => {
    try {
      const result = await tasksService.listProjects()
      setProjects(result.projects.filter((project) => project.archivedAt == null))
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
