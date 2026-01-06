import type { Task, Priority } from "@/data/sample-tasks"
import { generateTaskId } from "@/data/sample-tasks"

// ============================================================================
// SUBTASK TYPES
// ============================================================================

/**
 * Progress information for subtasks
 */
export interface SubtaskProgress {
  total: number
  completed: number
  percentage: number // 0-100
}

/**
 * Task with its subtasks and progress attached
 */
export type TaskWithSubtasks = Task & {
  subtasks: Task[]
  progress: SubtaskProgress
}

// ============================================================================
// SUBTASK HELPER FUNCTIONS
// ============================================================================

/**
 * Check if a task is a subtask (has a parent)
 */
export const isSubtask = (task: Task): boolean => {
  return task.parentId !== null
}

/**
 * Check if a task has subtasks
 */
export const hasSubtasks = (task: Task): boolean => {
  return task.subtaskIds.length > 0
}

/**
 * Get subtasks for a parent task in order
 */
export const getSubtasks = (parentId: string, allTasks: Task[]): Task[] => {
  const parent = allTasks.find((t) => t.id === parentId)
  if (!parent) return []

  // Return in order specified by subtaskIds
  return parent.subtaskIds
    .map((id) => allTasks.find((t) => t.id === id))
    .filter((t): t is Task => t !== undefined)
}

/**
 * Calculate progress for a list of subtasks
 */
export const calculateProgress = (subtasks: Task[]): SubtaskProgress => {
  const total = subtasks.length
  if (total === 0) {
    return { total: 0, completed: 0, percentage: 0 }
  }

  const completed = subtasks.filter((t) => t.completedAt !== null).length
  const percentage = Math.round((completed / total) * 100)

  return { total, completed, percentage }
}

/**
 * Get the parent task for a subtask
 */
export const getParentTask = (task: Task, allTasks: Task[]): Task | null => {
  if (!task.parentId) return null
  return allTasks.find((t) => t.id === task.parentId) || null
}

/**
 * Get only top-level tasks (tasks without a parent)
 */
export const getTopLevelTasks = (tasks: Task[]): Task[] => {
  return tasks.filter((t) => t.parentId === null)
}

/**
 * Build a task tree with subtasks attached to their parents
 */
export const buildTaskTree = (tasks: Task[]): TaskWithSubtasks[] => {
  const topLevel = getTopLevelTasks(tasks)

  return topLevel.map((task) => {
    const subtasks = getSubtasks(task.id, tasks)
    return {
      ...task,
      subtasks,
      progress: calculateProgress(subtasks),
    }
  })
}

/**
 * Get all subtask IDs for a parent task (for filtering)
 */
export const getAllSubtaskIds = (parentId: string, allTasks: Task[]): string[] => {
  const parent = allTasks.find((t) => t.id === parentId)
  if (!parent) return []
  return parent.subtaskIds
}

/**
 * Check if a task can have subtasks added
 * (subtasks themselves cannot have children)
 */
export const canHaveSubtasks = (task: Task): boolean => {
  return task.parentId === null
}

/**
 * Validate subtask relationships
 * - A task cannot be its own parent
 * - Circular references are not allowed
 * - Subtasks must belong to the same project as parent
 */
export const validateSubtaskRelationship = (
  parentId: string,
  subtaskId: string,
  allTasks: Task[]
): { valid: boolean; error?: string } => {
  // Cannot be own parent
  if (parentId === subtaskId) {
    return { valid: false, error: "A task cannot be its own parent" }
  }

  const parent = allTasks.find((t) => t.id === parentId)
  const subtask = allTasks.find((t) => t.id === subtaskId)

  if (!parent || !subtask) {
    return { valid: false, error: "Parent or subtask not found" }
  }

  // Subtask must be in same project
  if (parent.projectId !== subtask.projectId) {
    return { valid: false, error: "Subtask must belong to the same project as parent" }
  }

  // Parent cannot be a subtask itself (no nested subtasks)
  if (parent.parentId !== null) {
    return { valid: false, error: "Cannot add subtasks to a subtask (no nested subtasks)" }
  }

  // Subtask cannot already have subtasks (would create nested structure)
  if (subtask.subtaskIds.length > 0) {
    return { valid: false, error: "Cannot make a parent task into a subtask" }
  }

  return { valid: true }
}

/**
 * Filter tasks while maintaining subtask relationships
 * When a parent matches the filter, include all its subtasks
 */
export const filterTasksWithSubtasks = (
  tasks: Task[],
  filterFn: (task: Task) => boolean
): Task[] => {
  // Get top-level tasks that match the filter
  const matchingTopLevel = tasks.filter((t) => t.parentId === null && filterFn(t))

  // Get IDs of matching top-level tasks
  const matchingIds = new Set(matchingTopLevel.map((t) => t.id))

  // Include all subtasks of matching parents
  return tasks.filter(
    (t) =>
      matchingIds.has(t.id) || // Is a matching top-level task
      (t.parentId !== null && matchingIds.has(t.parentId)) // Is subtask of matching parent
  )
}

/**
 * Sort tasks maintaining parent-subtask order
 * Subtasks appear immediately after their parent in the specified order
 */
export const sortTasksWithSubtasks = (
  tasks: Task[],
  sortFn: (a: Task, b: Task) => number
): Task[] => {
  // First, sort top-level tasks
  const topLevel = tasks.filter((t) => t.parentId === null)
  const sortedTopLevel = [...topLevel].sort(sortFn)

  // Build result with subtasks inserted after parents
  const result: Task[] = []
  const taskMap = new Map(tasks.map((t) => [t.id, t]))

  for (const parent of sortedTopLevel) {
    result.push(parent)
    // Add subtasks in their specified order
    for (const subtaskId of parent.subtaskIds) {
      const subtask = taskMap.get(subtaskId)
      if (subtask) {
        result.push(subtask)
      }
    }
  }

  return result
}

// ============================================================================
// SUBTASK MANAGEMENT TYPES
// ============================================================================

/**
 * Result of a subtask operation
 */
export interface SubtaskOperationResult {
  success: boolean
  error?: string
  updatedTasks?: Task[]
  newTask?: Task
  newTasks?: Task[]  // T038: For bulk add operations
  reorderedTasks?: Task[]  // T039: For reorder operations
}

/**
 * Options for creating a subtask
 */
export interface CreateSubtaskOptions {
  title: string
  parentId: string
  priority?: Priority
  dueDate?: Date | null
  dueTime?: string | null
}

// ============================================================================
// SUBTASK MANAGEMENT FUNCTIONS
// ============================================================================

/**
 * Create a new subtask and attach it to a parent task
 * Returns the updated tasks array and the new subtask
 */
export const createSubtask = (
  options: CreateSubtaskOptions,
  allTasks: Task[]
): SubtaskOperationResult => {
  const { title, parentId, priority = "none", dueDate = null, dueTime = null } = options

  const parent = allTasks.find((t) => t.id === parentId)
  if (!parent) {
    return { success: false, error: "Parent task not found" }
  }

  if (parent.parentId !== null) {
    return { success: false, error: "Cannot add subtask to another subtask" }
  }

  const newSubtask: Task = {
    id: generateTaskId(),
    title,
    description: "",
    projectId: parent.projectId,
    statusId: parent.statusId,
    priority,
    dueDate,
    dueTime,
    isRepeating: false,
    repeatConfig: null,
    linkedNoteIds: [],
    sourceNoteId: null,
    parentId,
    subtaskIds: [], // Subtasks cannot have children
    createdAt: new Date(),
    completedAt: null,
    archivedAt: null,
  }

  // Update parent's subtaskIds
  const updatedParent: Task = {
    ...parent,
    subtaskIds: [...parent.subtaskIds, newSubtask.id],
  }

  // Create new tasks array with updated parent and new subtask
  const updatedTasks = allTasks.map((t) =>
    t.id === parentId ? updatedParent : t
  )
  updatedTasks.push(newSubtask)

  return {
    success: true,
    updatedTasks,
    newTask: newSubtask,
  }
}

/**
 * Create multiple subtasks at once (for bulk add)
 */
export const createMultipleSubtasks = (
  parentId: string,
  titles: string[],
  allTasks: Task[]
): SubtaskOperationResult => {
  if (titles.length === 0) {
    return { success: false, error: "No titles provided" }
  }

  const parent = allTasks.find((t) => t.id === parentId)
  if (!parent) {
    return { success: false, error: "Parent task not found" }
  }

  if (parent.parentId !== null) {
    return { success: false, error: "Cannot add subtask to another subtask" }
  }

  // Create all new subtasks
  const newSubtasks: Task[] = titles.map((title) => ({
    id: generateTaskId(),
    title,
    description: "",
    projectId: parent.projectId,
    statusId: parent.statusId,
    priority: "none" as const,
    dueDate: null,
    dueTime: null,
    isRepeating: false,
    repeatConfig: null,
    linkedNoteIds: [],
    sourceNoteId: null,
    parentId,
    subtaskIds: [],
    createdAt: new Date(),
    completedAt: null,
    archivedAt: null,
  }))

  // Update parent's subtaskIds with all new IDs
  const newSubtaskIds = newSubtasks.map((s) => s.id)
  const updatedParent: Task = {
    ...parent,
    subtaskIds: [...parent.subtaskIds, ...newSubtaskIds],
  }

  // Create new tasks array with updated parent and all new subtasks
  const updatedTasks = allTasks.map((t) =>
    t.id === parentId ? updatedParent : t
  )
  updatedTasks.push(...newSubtasks)

  return {
    success: true,
    updatedTasks,
    newTasks: newSubtasks,  // T038: Return new tasks for database persistence
  }
}

/**
 * Reorder subtasks within a parent task
 * Handles partial reordering when some subtask IDs may be orphaned
 */
export const reorderSubtasks = (
  parentId: string,
  newOrder: string[],
  allTasks: Task[]
): SubtaskOperationResult => {
  const parent = allTasks.find((t) => t.id === parentId)
  if (!parent) {
    return { success: false, error: "Parent task not found" }
  }

  // Validate that all IDs in newOrder exist in parent's subtaskIds
  const existingIds = new Set(parent.subtaskIds)
  const allIdsValid = newOrder.every((id) => existingIds.has(id))
  if (!allIdsValid) {
    return { success: false, error: "Invalid subtask IDs in new order" }
  }

  // Build final order: start with newOrder, then append any missing IDs
  // This handles case where some subtaskIds exist but aren't in the visible subtasks
  // (e.g., orphaned IDs that weren't found in allTasks)
  const newOrderSet = new Set(newOrder)
  const missingIds = parent.subtaskIds.filter((id) => !newOrderSet.has(id))
  const finalOrder = [...newOrder, ...missingIds]

  // Update parent's subtaskIds
  const updatedParent: Task = {
    ...parent,
    subtaskIds: finalOrder,
  }

  const updatedTasks = allTasks.map((t) =>
    t.id === parentId ? updatedParent : t
  )

  // T039: Get the reordered subtasks for database position updates
  const reorderedTasks = finalOrder
    .map((id) => allTasks.find((t) => t.id === id))
    .filter((t): t is Task => t !== undefined)

  return {
    success: true,
    updatedTasks,
    reorderedTasks,  // T039: Return reordered tasks for database persistence
  }
}

/**
 * Promote a subtask to a standalone task
 */
export const promoteToTask = (
  subtaskId: string,
  allTasks: Task[]
): SubtaskOperationResult => {
  const subtask = allTasks.find((t) => t.id === subtaskId)
  if (!subtask) {
    return { success: false, error: "Subtask not found" }
  }

  if (!subtask.parentId) {
    return { success: false, error: "Task is already a standalone task" }
  }

  const parent = allTasks.find((t) => t.id === subtask.parentId)
  if (!parent) {
    return { success: false, error: "Parent task not found" }
  }

  // Remove from parent's subtaskIds
  const updatedParent: Task = {
    ...parent,
    subtaskIds: parent.subtaskIds.filter((id) => id !== subtaskId),
  }

  // Update subtask to be standalone
  const updatedSubtask: Task = {
    ...subtask,
    parentId: null,
  }

  const updatedTasks = allTasks.map((t) => {
    if (t.id === parent.id) return updatedParent
    if (t.id === subtaskId) return updatedSubtask
    return t
  })

  return {
    success: true,
    updatedTasks,
  }
}

/**
 * Demote a standalone task to become a subtask of another task
 */
export const demoteToSubtask = (
  taskId: string,
  newParentId: string,
  allTasks: Task[]
): SubtaskOperationResult => {
  // Validate the relationship first
  const validation = validateSubtaskRelationship(newParentId, taskId, allTasks)
  if (!validation.valid) {
    return { success: false, error: validation.error }
  }

  const task = allTasks.find((t) => t.id === taskId)
  const newParent = allTasks.find((t) => t.id === newParentId)

  if (!task || !newParent) {
    return { success: false, error: "Task or parent not found" }
  }

  // Check if task already has a parent (shouldn't happen based on validation, but extra safety)
  if (task.parentId !== null) {
    return { success: false, error: "Task is already a subtask" }
  }

  // Update task to be subtask (inherit project from parent if different)
  const updatedTask: Task = {
    ...task,
    parentId: newParentId,
    projectId: newParent.projectId,
    statusId: newParent.statusId,
  }

  // Add to parent's subtaskIds
  const updatedParent: Task = {
    ...newParent,
    subtaskIds: [...newParent.subtaskIds, taskId],
  }

  const updatedTasks = allTasks.map((t) => {
    if (t.id === taskId) return updatedTask
    if (t.id === newParentId) return updatedParent
    return t
  })

  return {
    success: true,
    updatedTasks,
  }
}

/**
 * Delete a subtask
 */
export const deleteSubtask = (
  subtaskId: string,
  allTasks: Task[]
): SubtaskOperationResult => {
  const subtask = allTasks.find((t) => t.id === subtaskId)
  if (!subtask) {
    return { success: false, error: "Subtask not found" }
  }

  if (!subtask.parentId) {
    return { success: false, error: "Task is not a subtask" }
  }

  const parent = allTasks.find((t) => t.id === subtask.parentId)
  if (!parent) {
    return { success: false, error: "Parent task not found" }
  }

  // Remove from parent's subtaskIds
  const updatedParent: Task = {
    ...parent,
    subtaskIds: parent.subtaskIds.filter((id) => id !== subtaskId),
  }

  // Remove the subtask from tasks array
  const updatedTasks = allTasks
    .filter((t) => t.id !== subtaskId)
    .map((t) => (t.id === parent.id ? updatedParent : t))

  return {
    success: true,
    updatedTasks,
  }
}

/**
 * Delete a parent task with options for handling subtasks
 */
export const deleteParentWithSubtasks = (
  parentId: string,
  keepSubtasks: boolean,
  allTasks: Task[]
): SubtaskOperationResult => {
  const parent = allTasks.find((t) => t.id === parentId)
  if (!parent) {
    return { success: false, error: "Parent task not found" }
  }

  let updatedTasks: Task[]

  if (keepSubtasks) {
    // Promote all subtasks to standalone tasks
    updatedTasks = allTasks
      .filter((t) => t.id !== parentId) // Remove parent
      .map((t) => {
        if (t.parentId === parentId) {
          // Promote subtask
          return { ...t, parentId: null }
        }
        return t
      })
  } else {
    // Delete parent and all subtasks
    const subtaskIds = new Set(parent.subtaskIds)
    updatedTasks = allTasks.filter(
      (t) => t.id !== parentId && !subtaskIds.has(t.id)
    )
  }

  return {
    success: true,
    updatedTasks,
  }
}

/**
 * Complete a parent task with options for handling incomplete subtasks
 */
export const completeParentWithSubtasks = (
  parentId: string,
  completeSubtasks: boolean,
  allTasks: Task[]
): SubtaskOperationResult => {
  const parent = allTasks.find((t) => t.id === parentId)
  if (!parent) {
    return { success: false, error: "Parent task not found" }
  }

  const now = new Date()

  const updatedTasks = allTasks.map((t) => {
    // Complete the parent
    if (t.id === parentId) {
      return { ...t, completedAt: now }
    }

    // Complete subtasks if requested
    if (completeSubtasks && t.parentId === parentId && !t.completedAt) {
      return { ...t, completedAt: now }
    }

    return t
  })

  return {
    success: true,
    updatedTasks,
  }
}

/**
 * Get incomplete subtasks for a parent task
 */
export const getIncompleteSubtasks = (
  parentId: string,
  allTasks: Task[]
): Task[] => {
  return allTasks.filter(
    (t) => t.parentId === parentId && t.completedAt === null
  )
}

/**
 * Check if a parent task has incomplete subtasks
 */
export const hasIncompleteSubtasks = (
  parentId: string,
  allTasks: Task[]
): boolean => {
  return getIncompleteSubtasks(parentId, allTasks).length > 0
}

/**
 * Get potential parent tasks for demoting a task
 * Excludes the task itself, subtasks, and tasks that are already subtasks
 */
export const getPotentialParents = (
  taskId: string,
  allTasks: Task[],
  currentProjectId?: string
): Task[] => {
  const task = allTasks.find((t) => t.id === taskId)
  if (!task) return []

  return allTasks.filter((t) => {
    // Cannot be itself
    if (t.id === taskId) return false
    // Cannot be a subtask
    if (t.parentId !== null) return false
    // Cannot have subtasks already (would create deep nesting)
    // Actually, we allow tasks with subtasks to be parents
    // The task being demoted just becomes another sibling
    return true
  }).sort((a, b) => {
    // Prioritize same project
    if (currentProjectId) {
      const aInProject = a.projectId === currentProjectId
      const bInProject = b.projectId === currentProjectId
      if (aInProject && !bInProject) return -1
      if (!aInProject && bInProject) return 1
    }
    // Then by recency
    return b.createdAt.getTime() - a.createdAt.getTime()
  })
}
