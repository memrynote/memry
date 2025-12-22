import { generateTaskId, type Task, type Priority } from "@/data/sample-tasks"
import { getSubtasks } from "./subtask-utils"

// ============================================================================
// TYPES
// ============================================================================

export interface BulkOperationResult {
  success: boolean
  error?: string
  updatedTasks?: Task[]
  affectedCount?: number
  // For database-aware callbacks
  completedSubtasks?: Task[]
  incompleteSubtasks?: Task[]
}

// ============================================================================
// CHECK ALL SUBTASKS COMPLETE
// ============================================================================

/**
 * Check if all subtasks of a parent task are complete
 */
export const checkAllSubtasksComplete = (
  parentId: string,
  allTasks: Task[]
): boolean => {
  const subtasks = getSubtasks(parentId, allTasks)
  if (subtasks.length === 0) return false
  return subtasks.every((s) => s.completedAt !== null)
}

/**
 * Get count of incomplete subtasks for a parent
 */
export const getIncompleteSubtaskCount = (
  parentId: string,
  allTasks: Task[]
): number => {
  const subtasks = getSubtasks(parentId, allTasks)
  return subtasks.filter((s) => s.completedAt === null).length
}

// ============================================================================
// COMPLETE ALL SUBTASKS
// ============================================================================

/**
 * Mark all subtasks of a parent as complete
 */
export const completeAllSubtasks = (
  parentId: string,
  allTasks: Task[]
): BulkOperationResult => {
  const parent = allTasks.find((t) => t.id === parentId)
  if (!parent) {
    return { success: false, error: "Parent task not found" }
  }

  const subtasks = getSubtasks(parentId, allTasks)
  if (subtasks.length === 0) {
    return { success: false, error: "No subtasks to complete" }
  }

  const now = new Date()
  const incompleteSubtasks = subtasks.filter((s) => s.completedAt === null)
  const incompleteIds = new Set(incompleteSubtasks.map((s) => s.id))

  if (incompleteIds.size === 0) {
    return { success: false, error: "All subtasks are already complete" }
  }

  const updatedTasks = allTasks.map((t) =>
    incompleteIds.has(t.id) ? { ...t, completedAt: now } : t
  )

  return {
    success: true,
    updatedTasks,
    affectedCount: incompleteIds.size,
    completedSubtasks: incompleteSubtasks,
  }
}

// ============================================================================
// MARK ALL SUBTASKS INCOMPLETE
// ============================================================================

/**
 * Mark all subtasks of a parent as incomplete
 */
export const markAllSubtasksIncomplete = (
  parentId: string,
  allTasks: Task[]
): BulkOperationResult => {
  const parent = allTasks.find((t) => t.id === parentId)
  if (!parent) {
    return { success: false, error: "Parent task not found" }
  }

  const subtasks = getSubtasks(parentId, allTasks)
  if (subtasks.length === 0) {
    return { success: false, error: "No subtasks to mark incomplete" }
  }

  const completedSubtasks = subtasks.filter((s) => s.completedAt !== null)
  const completedIds = new Set(completedSubtasks.map((s) => s.id))

  if (completedIds.size === 0) {
    return { success: false, error: "All subtasks are already incomplete" }
  }

  const updatedTasks = allTasks.map((t) =>
    completedIds.has(t.id) ? { ...t, completedAt: null } : t
  )

  return {
    success: true,
    updatedTasks,
    affectedCount: completedIds.size,
    incompleteSubtasks: completedSubtasks, // Return the subtasks that were marked incomplete
  }
}

// ============================================================================
// SET DUE DATE FOR ALL SUBTASKS
// ============================================================================

/**
 * Set due date for all subtasks of a parent
 */
export const setDueDateForAllSubtasks = (
  parentId: string,
  dueDate: Date | null,
  includeCompleted: boolean,
  allTasks: Task[]
): BulkOperationResult => {
  const parent = allTasks.find((t) => t.id === parentId)
  if (!parent) {
    return { success: false, error: "Parent task not found" }
  }

  const subtasks = getSubtasks(parentId, allTasks)
  if (subtasks.length === 0) {
    return { success: false, error: "No subtasks to update" }
  }

  const targetSubtasks = includeCompleted
    ? subtasks
    : subtasks.filter((s) => s.completedAt === null)

  if (targetSubtasks.length === 0) {
    return { success: false, error: "No matching subtasks to update" }
  }

  const targetIds = new Set(targetSubtasks.map((s) => s.id))

  const updatedTasks = allTasks.map((t) =>
    targetIds.has(t.id) ? { ...t, dueDate } : t
  )

  return {
    success: true,
    updatedTasks,
    affectedCount: targetIds.size,
  }
}

// ============================================================================
// SET PRIORITY FOR ALL SUBTASKS
// ============================================================================

/**
 * Set priority for all subtasks of a parent
 */
export const setPriorityForAllSubtasks = (
  parentId: string,
  priority: Priority,
  includeCompleted: boolean,
  allTasks: Task[]
): BulkOperationResult => {
  const parent = allTasks.find((t) => t.id === parentId)
  if (!parent) {
    return { success: false, error: "Parent task not found" }
  }

  const subtasks = getSubtasks(parentId, allTasks)
  if (subtasks.length === 0) {
    return { success: false, error: "No subtasks to update" }
  }

  const targetSubtasks = includeCompleted
    ? subtasks
    : subtasks.filter((s) => s.completedAt === null)

  if (targetSubtasks.length === 0) {
    return { success: false, error: "No matching subtasks to update" }
  }

  const targetIds = new Set(targetSubtasks.map((s) => s.id))

  const updatedTasks = allTasks.map((t) =>
    targetIds.has(t.id) ? { ...t, priority } : t
  )

  return {
    success: true,
    updatedTasks,
    affectedCount: targetIds.size,
  }
}

// ============================================================================
// DELETE ALL SUBTASKS
// ============================================================================

/**
 * Delete all subtasks of a parent
 */
export const deleteAllSubtasks = (
  parentId: string,
  allTasks: Task[]
): BulkOperationResult => {
  const parent = allTasks.find((t) => t.id === parentId)
  if (!parent) {
    return { success: false, error: "Parent task not found" }
  }

  const subtasks = getSubtasks(parentId, allTasks)
  if (subtasks.length === 0) {
    return { success: false, error: "No subtasks to delete" }
  }

  const subtaskIds = new Set(subtasks.map((s) => s.id))

  // Update parent to clear subtaskIds
  const updatedParent: Task = {
    ...parent,
    subtaskIds: [],
  }

  // Remove subtasks and update parent
  const updatedTasks = allTasks
    .filter((t) => !subtaskIds.has(t.id))
    .map((t) => (t.id === parentId ? updatedParent : t))

  return {
    success: true,
    updatedTasks,
    affectedCount: subtaskIds.size,
  }
}

// ============================================================================
// DUPLICATE TASK WITH SUBTASKS
// ============================================================================

/**
 * Duplicate a task, optionally including its subtasks
 */
export const duplicateTaskWithSubtasks = (
  taskId: string,
  includeSubtasks: boolean,
  allTasks: Task[],
  newStatusId?: string
): BulkOperationResult => {
  const task = allTasks.find((t) => t.id === taskId)
  if (!task) {
    return { success: false, error: "Task not found" }
  }

  const newTaskId = generateTaskId()
  const now = new Date()

  // Create the duplicated task
  const duplicatedTask: Task = {
    ...task,
    id: newTaskId,
    title: `${task.title} (copy)`,
    statusId: newStatusId || task.statusId,
    completedAt: null,
    archivedAt: null,
    subtaskIds: [],
    createdAt: now,
  }

  let updatedTasks = [...allTasks, duplicatedTask]
  let subtaskCount = 0

  // Duplicate subtasks if requested
  if (includeSubtasks && task.subtaskIds.length > 0) {
    const subtasks = getSubtasks(taskId, allTasks)
    const newSubtaskIds: string[] = []

    for (const subtask of subtasks) {
      const newSubtaskId = generateTaskId()
      const duplicatedSubtask: Task = {
        ...subtask,
        id: newSubtaskId,
        parentId: newTaskId,
        completedAt: null,
        archivedAt: null,
        createdAt: now,
      }

      updatedTasks.push(duplicatedSubtask)
      newSubtaskIds.push(newSubtaskId)
      subtaskCount++
    }

    // Update the duplicated task with new subtask IDs
    updatedTasks = updatedTasks.map((t) =>
      t.id === newTaskId ? { ...t, subtaskIds: newSubtaskIds } : t
    )
  }

  return {
    success: true,
    updatedTasks,
    affectedCount: subtaskCount + 1, // task + subtasks
  }
}

// ============================================================================
// AUTO-COMPLETE PARENT
// ============================================================================

/**
 * Complete parent task (used after all subtasks are complete)
 */
export const completeParentTask = (
  parentId: string,
  allTasks: Task[]
): BulkOperationResult => {
  const parent = allTasks.find((t) => t.id === parentId)
  if (!parent) {
    return { success: false, error: "Parent task not found" }
  }

  if (parent.completedAt !== null) {
    return { success: false, error: "Parent task is already complete" }
  }

  const updatedTasks = allTasks.map((t) =>
    t.id === parentId ? { ...t, completedAt: new Date() } : t
  )

  return {
    success: true,
    updatedTasks,
  }
}

/**
 * Uncomplete parent task (for undo functionality)
 */
export const uncompleteParentTask = (
  parentId: string,
  allTasks: Task[]
): BulkOperationResult => {
  const parent = allTasks.find((t) => t.id === parentId)
  if (!parent) {
    return { success: false, error: "Parent task not found" }
  }

  const updatedTasks = allTasks.map((t) =>
    t.id === parentId ? { ...t, completedAt: null } : t
  )

  return {
    success: true,
    updatedTasks,
  }
}








