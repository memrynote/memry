import type { Task } from '@/data/sample-tasks'
import type { Project } from '@/data/tasks-data'

// ============================================================================
// PROJECT LOOKUP UTILITIES
// ============================================================================

/**
 * Create a Map<projectId, Project> for O(1) lookups
 * Use this instead of projects.find() in render loops
 */
export const createProjectMap = (projects: Project[]): Map<string, Project> => {
  return new Map(projects.map((p) => [p.id, p]))
}

// ============================================================================
// COMPLETION STATUS UTILITIES
// ============================================================================

/**
 * Create a nested Map for O(1) completion status lookups
 * Structure: Map<projectId, Map<statusId, isDone>>
 */
export const createCompletionStatusMap = (
  projects: Project[]
): Map<string, Map<string, boolean>> => {
  const map = new Map<string, Map<string, boolean>>()

  projects.forEach((project) => {
    const statusMap = new Map<string, boolean>()
    project.statuses.forEach((status) => {
      statusMap.set(status.id, status.type === 'done')
    })
    map.set(project.id, statusMap)
  })

  return map
}

/**
 * Fast isTaskCompleted check using pre-computed maps
 * O(1) complexity vs O(n) for projects.find()
 */
export const isTaskCompletedFast = (
  task: Task,
  completionMap: Map<string, Map<string, boolean>>
): boolean => {
  const statusMap = completionMap.get(task.projectId)
  if (!statusMap) return false
  return statusMap.get(task.statusId) ?? false
}

/**
 * Get project from map with fallback
 */
export const getProjectFromMap = (
  projectId: string,
  projectMap: Map<string, Project>
): Project | undefined => {
  return projectMap.get(projectId)
}

// ============================================================================
// HOOK-FRIENDLY UTILITIES
// ============================================================================

/**
 * Combined lookup context for use in components
 */
export interface LookupContext {
  projectMap: Map<string, Project>
  completionMap: Map<string, Map<string, boolean>>
}

/**
 * Create lookup context from projects array
 * Use with useMemo: useMemo(() => createLookupContext(projects), [projects])
 */
export const createLookupContext = (projects: Project[]): LookupContext => {
  return {
    projectMap: createProjectMap(projects),
    completionMap: createCompletionStatusMap(projects)
  }
}

/**
 * Get project and completion status in one call
 */
export const getTaskContext = (
  task: Task,
  lookupContext: LookupContext
): { project: Project | undefined; isCompleted: boolean } => {
  const project = lookupContext.projectMap.get(task.projectId)
  const isCompleted = isTaskCompletedFast(task, lookupContext.completionMap)
  return { project, isCompleted }
}
