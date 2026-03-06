/**
 * Task query functions for Drizzle ORM.
 * These queries operate on data.db (source of truth for tasks).
 *
 * @module db/queries/tasks
 */

import { eq, desc, asc, and, lte, gte, isNull, isNotNull, sql, count, type SQL } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { tasks, type Task, type NewTask } from '@memry/db-schema/schema/tasks'
import { taskTags, taskNotes, type NewTaskTag, type NewTaskNote } from '@memry/db-schema/schema/task-relations'
import * as schema from '@memry/db-schema/schema'

type DrizzleDb = BetterSQLite3Database<typeof schema>

// ============================================================================
// Task CRUD
// ============================================================================

/**
 * Insert a new task.
 */
export function insertTask(db: DrizzleDb, task: NewTask): Task {
  return db.insert(tasks).values(task).returning().get()
}

/**
 * Update an existing task.
 */
export function updateTask(
  db: DrizzleDb,
  id: string,
  updates: Partial<Omit<Task, 'id' | 'createdAt'>>
): Task | undefined {
  return db
    .update(tasks)
    .set({
      ...updates,
      modifiedAt: new Date().toISOString()
    })
    .where(eq(tasks.id, id))
    .returning()
    .get()
}

/**
 * Delete a task by ID.
 */
export function deleteTask(db: DrizzleDb, id: string): void {
  db.delete(tasks).where(eq(tasks.id, id)).run()
}

/**
 * Get a task by ID.
 */
export function getTaskById(db: DrizzleDb, id: string): Task | undefined {
  return db.select().from(tasks).where(eq(tasks.id, id)).get()
}

/**
 * Check if a task exists.
 */
export function taskExists(db: DrizzleDb, id: string): boolean {
  const result = db.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, id)).get()
  return result !== undefined
}

// ============================================================================
// Task Listing
// ============================================================================

export interface ListTasksOptions {
  projectId?: string
  statusId?: string | null
  parentId?: string | null
  includeCompleted?: boolean
  includeArchived?: boolean
  dueBefore?: string
  dueAfter?: string
  tags?: string[]
  search?: string
  sortBy?: 'position' | 'dueDate' | 'priority' | 'created' | 'modified'
  sortOrder?: 'asc' | 'desc'
  limit?: number
  offset?: number
}

/**
 * List tasks with filtering and sorting.
 */
export function listTasks(db: DrizzleDb, options: ListTasksOptions = {}): Task[] {
  const {
    projectId,
    statusId,
    parentId,
    includeCompleted = false,
    includeArchived = false,
    dueBefore,
    dueAfter,
    tags,
    sortBy = 'position',
    sortOrder = 'asc',
    limit = 100,
    offset = 0
  } = options

  const conditions: SQL<unknown>[] = []

  if (projectId) {
    conditions.push(eq(tasks.projectId, projectId))
  }

  if (statusId !== undefined) {
    if (statusId === null) {
      conditions.push(isNull(tasks.statusId))
    } else {
      conditions.push(eq(tasks.statusId, statusId))
    }
  }

  if (parentId !== undefined) {
    if (parentId === null) {
      conditions.push(isNull(tasks.parentId))
    } else {
      conditions.push(eq(tasks.parentId, parentId))
    }
  }

  if (!includeCompleted) {
    conditions.push(isNull(tasks.completedAt))
  }

  if (!includeArchived) {
    conditions.push(isNull(tasks.archivedAt))
  }

  if (dueBefore) {
    conditions.push(lte(tasks.dueDate, dueBefore))
  }

  if (dueAfter) {
    conditions.push(gte(tasks.dueDate, dueAfter))
  }

  // Filter by tags if specified
  if (tags && tags.length > 0) {
    const tagResults = db
      .select({
        taskId: taskTags.taskId,
        tagCount: sql<number>`count(distinct ${taskTags.tag})`
      })
      .from(taskTags)
      .where(sql`lower(${taskTags.tag}) IN ${tags.map((t) => t.toLowerCase())}`)
      .groupBy(taskTags.taskId)
      .all()

    const taskIdsWithTags = tagResults
      .filter((r) => r.tagCount === tags.length)
      .map((r) => r.taskId)

    if (taskIdsWithTags.length === 0) {
      return []
    }

    conditions.push(sql`${tasks.id} IN ${taskIdsWithTags}`)
  }

  // Build sort order
  const sortColumn =
    sortBy === 'position'
      ? tasks.position
      : sortBy === 'dueDate'
        ? tasks.dueDate
        : sortBy === 'priority'
          ? tasks.priority
          : sortBy === 'created'
            ? tasks.createdAt
            : tasks.modifiedAt

  const orderFn = sortOrder === 'asc' ? asc : desc

  let query = db.select().from(tasks)

  if (conditions.length > 0) {
    query = query.where(and(...conditions)) as typeof query
  }

  return query.orderBy(orderFn(sortColumn)).limit(limit).offset(offset).all()
}

/**
 * Count tasks with optional filters.
 */
export function countTasks(
  db: DrizzleDb,
  options: Pick<ListTasksOptions, 'projectId' | 'includeCompleted' | 'includeArchived'> = {}
): number {
  const { projectId, includeCompleted = false, includeArchived = false } = options

  const conditions: SQL<unknown>[] = []

  if (projectId) {
    conditions.push(eq(tasks.projectId, projectId))
  }

  if (!includeCompleted) {
    conditions.push(isNull(tasks.completedAt))
  }

  if (!includeArchived) {
    conditions.push(isNull(tasks.archivedAt))
  }

  let query = db.select({ count: count() }).from(tasks)

  if (conditions.length > 0) {
    query = query.where(and(...conditions)) as typeof query
  }

  const result = query.get()
  return result?.count ?? 0
}

/**
 * Get tasks by project ID.
 */
export function getTasksByProject(db: DrizzleDb, projectId: string): Task[] {
  return db
    .select()
    .from(tasks)
    .where(and(eq(tasks.projectId, projectId), isNull(tasks.archivedAt)))
    .orderBy(asc(tasks.position))
    .all()
}

/**
 * Get subtasks of a parent task.
 */
export function getSubtasks(db: DrizzleDb, parentId: string): Task[] {
  return db
    .select()
    .from(tasks)
    .where(eq(tasks.parentId, parentId))
    .orderBy(asc(tasks.position))
    .all()
}

/**
 * Count subtasks of a parent task.
 */
export function countSubtasks(
  db: DrizzleDb,
  parentId: string
): { total: number; completed: number } {
  const result = db
    .select({
      total: count(),
      completed: sql<number>`sum(case when ${tasks.completedAt} is not null then 1 else 0 end)`
    })
    .from(tasks)
    .where(eq(tasks.parentId, parentId))
    .get()

  return {
    total: result?.total ?? 0,
    completed: result?.completed ?? 0
  }
}

// ============================================================================
// Task Views (Today, Upcoming, Overdue)
// ============================================================================

/**
 * Get today's date in YYYY-MM-DD format.
 */
function toLocalDateStr(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function getTodayDate(): string {
  return toLocalDateStr(new Date())
}

/**
 * Get tasks due today.
 */
export function getTodayTasks(db: DrizzleDb): Task[] {
  const today = getTodayDate()

  return db
    .select()
    .from(tasks)
    .where(and(eq(tasks.dueDate, today), isNull(tasks.completedAt), isNull(tasks.archivedAt)))
    .orderBy(asc(tasks.dueTime), asc(tasks.position))
    .all()
}

/**
 * Get tasks due on a specific date.
 * Used by journal day context sidebar.
 *
 * @param db - Database instance
 * @param date - Date in YYYY-MM-DD format
 * @param includeCompleted - Whether to include completed tasks (default: true)
 * @returns Tasks due on the specified date, ordered by time and position
 */
export function getTasksByDueDate(
  db: DrizzleDb,
  date: string,
  includeCompleted: boolean = true
): Task[] {
  const conditions: SQL<unknown>[] = [eq(tasks.dueDate, date), isNull(tasks.archivedAt)]

  if (!includeCompleted) {
    conditions.push(isNull(tasks.completedAt))
  }

  return db
    .select()
    .from(tasks)
    .where(and(...conditions))
    .orderBy(asc(tasks.dueTime), asc(tasks.position))
    .all()
}

/**
 * Count overdue tasks before a specific date.
 * Used by journal day context sidebar to show overdue badge.
 *
 * @param db - Database instance
 * @param beforeDate - Date in YYYY-MM-DD format (exclusive)
 * @returns Count of overdue tasks
 */
export function countOverdueTasksBeforeDate(db: DrizzleDb, beforeDate: string): number {
  const result = db
    .select({ count: count() })
    .from(tasks)
    .where(
      and(
        isNotNull(tasks.dueDate),
        sql`${tasks.dueDate} < ${beforeDate}`,
        isNull(tasks.completedAt),
        isNull(tasks.archivedAt)
      )
    )
    .get()

  return result?.count ?? 0
}

/**
 * Get overdue tasks (due before today and not completed).
 */
export function getOverdueTasks(db: DrizzleDb): Task[] {
  const today = getTodayDate()

  return db
    .select()
    .from(tasks)
    .where(
      and(
        isNotNull(tasks.dueDate),
        sql`${tasks.dueDate} < ${today}`,
        isNull(tasks.completedAt),
        isNull(tasks.archivedAt)
      )
    )
    .orderBy(asc(tasks.dueDate), asc(tasks.position))
    .all()
}

/**
 * Get upcoming tasks (due within the next N days).
 */
export function getUpcomingTasks(db: DrizzleDb, days: number = 7): Task[] {
  const today = getTodayDate()
  const futureDate = new Date()
  futureDate.setDate(futureDate.getDate() + days)
  const futureDateStr = toLocalDateStr(futureDate)

  return db
    .select()
    .from(tasks)
    .where(
      and(
        isNotNull(tasks.dueDate),
        gte(tasks.dueDate, today),
        lte(tasks.dueDate, futureDateStr),
        isNull(tasks.completedAt),
        isNull(tasks.archivedAt)
      )
    )
    .orderBy(asc(tasks.dueDate), asc(tasks.dueTime), asc(tasks.position))
    .all()
}

// ============================================================================
// Task Actions
// ============================================================================

/**
 * Complete a task.
 */
export function completeTask(db: DrizzleDb, id: string, completedAt?: string): Task | undefined {
  return db
    .update(tasks)
    .set({
      completedAt: completedAt ?? new Date().toISOString(),
      modifiedAt: new Date().toISOString()
    })
    .where(eq(tasks.id, id))
    .returning()
    .get()
}

/**
 * Uncomplete a task.
 */
export function uncompleteTask(db: DrizzleDb, id: string): Task | undefined {
  return db
    .update(tasks)
    .set({
      completedAt: null,
      modifiedAt: new Date().toISOString()
    })
    .where(eq(tasks.id, id))
    .returning()
    .get()
}

/**
 * Archive a task.
 */
export function archiveTask(db: DrizzleDb, id: string): Task | undefined {
  return db
    .update(tasks)
    .set({
      archivedAt: new Date().toISOString(),
      modifiedAt: new Date().toISOString()
    })
    .where(eq(tasks.id, id))
    .returning()
    .get()
}

/**
 * Unarchive a task.
 */
export function unarchiveTask(db: DrizzleDb, id: string): Task | undefined {
  return db
    .update(tasks)
    .set({
      archivedAt: null,
      modifiedAt: new Date().toISOString()
    })
    .where(eq(tasks.id, id))
    .returning()
    .get()
}

/**
 * Move a task to a different project/status/parent.
 */
export function moveTask(
  db: DrizzleDb,
  id: string,
  updates: {
    projectId?: string
    statusId?: string | null
    parentId?: string | null
    position?: number
  }
): Task | undefined {
  return db
    .update(tasks)
    .set({
      ...updates,
      modifiedAt: new Date().toISOString()
    })
    .where(eq(tasks.id, id))
    .returning()
    .get()
}

/**
 * Reorder tasks by updating their positions.
 */
export function reorderTasks(db: DrizzleDb, taskIds: string[], positions: number[]): void {
  if (taskIds.length !== positions.length) {
    throw new Error('taskIds and positions arrays must have the same length')
  }

  for (let i = 0; i < taskIds.length; i++) {
    db.update(tasks)
      .set({
        position: positions[i],
        modifiedAt: new Date().toISOString()
      })
      .where(eq(tasks.id, taskIds[i]))
      .run()
  }
}

/**
 * Duplicate a task.
 */
export function duplicateTask(db: DrizzleDb, id: string, newId: string): Task | undefined {
  const original = getTaskById(db, id)
  if (!original) {
    return undefined
  }

  const now = new Date().toISOString()
  const duplicate: NewTask = {
    id: newId,
    projectId: original.projectId,
    statusId: original.statusId,
    parentId: original.parentId,
    title: `Copy of ${original.title}`,
    description: original.description,
    priority: original.priority,
    position: original.position + 1,
    dueDate: original.dueDate,
    dueTime: original.dueTime,
    startDate: original.startDate,
    repeatConfig: original.repeatConfig,
    repeatFrom: original.repeatFrom,
    createdAt: now,
    modifiedAt: now
  }

  return insertTask(db, duplicate)
}

/**
 * Duplicate a subtask with a new parent.
 * Unlike duplicateTask, this preserves the original title (no "Copy of" prefix)
 * and assigns the subtask to a new parent.
 */
export function duplicateSubtask(
  db: DrizzleDb,
  id: string,
  newId: string,
  newParentId: string
): Task | undefined {
  const original = getTaskById(db, id)
  if (!original) {
    return undefined
  }

  const now = new Date().toISOString()
  const duplicate: NewTask = {
    id: newId,
    projectId: original.projectId,
    statusId: original.statusId,
    parentId: newParentId,
    title: original.title, // Keep original title for subtasks
    description: original.description,
    priority: original.priority,
    position: original.position,
    dueDate: original.dueDate,
    dueTime: original.dueTime,
    startDate: original.startDate,
    repeatConfig: original.repeatConfig,
    repeatFrom: original.repeatFrom,
    createdAt: now,
    modifiedAt: now
  }

  return insertTask(db, duplicate)
}

// ============================================================================
// Task Tags
// ============================================================================

/**
 * Set tags for a task (replaces existing tags).
 */
export function setTaskTags(db: DrizzleDb, taskId: string, tags: string[]): void {
  // Delete existing tags
  db.delete(taskTags).where(eq(taskTags.taskId, taskId)).run()

  // Insert new tags
  if (tags.length > 0) {
    const tagRecords: NewTaskTag[] = tags.map((tag) => ({
      taskId,
      tag: tag.toLowerCase().trim()
    }))
    db.insert(taskTags).values(tagRecords).run()
  }
}

/**
 * Get tags for a task.
 */
export function getTaskTags(db: DrizzleDb, taskId: string): string[] {
  const results = db
    .select({ tag: taskTags.tag })
    .from(taskTags)
    .where(eq(taskTags.taskId, taskId))
    .all()

  return results.map((r) => r.tag)
}

/**
 * Get all unique task tags with counts.
 */
export function getAllTaskTags(db: DrizzleDb): { tag: string; count: number }[] {
  return db
    .select({
      tag: taskTags.tag,
      count: count()
    })
    .from(taskTags)
    .groupBy(taskTags.tag)
    .orderBy(desc(count()))
    .all()
}

// ============================================================================
// Task-Note Links
// ============================================================================

/**
 * Set linked notes for a task (replaces existing links).
 */
export function setTaskNotes(db: DrizzleDb, taskId: string, noteIds: string[]): void {
  // Delete existing links
  db.delete(taskNotes).where(eq(taskNotes.taskId, taskId)).run()

  // Insert new links
  if (noteIds.length > 0) {
    const linkRecords: NewTaskNote[] = noteIds.map((noteId) => ({
      taskId,
      noteId
    }))
    db.insert(taskNotes).values(linkRecords).run()
  }
}

/**
 * Get linked note IDs for a task.
 */
export function getTaskNoteIds(db: DrizzleDb, taskId: string): string[] {
  const results = db
    .select({ noteId: taskNotes.noteId })
    .from(taskNotes)
    .where(eq(taskNotes.taskId, taskId))
    .all()

  return results.map((r) => r.noteId)
}

/**
 * Get tasks linked to a specific note.
 */
export function getTasksLinkedToNote(db: DrizzleDb, noteId: string): Task[] {
  const taskIds = db
    .select({ taskId: taskNotes.taskId })
    .from(taskNotes)
    .where(eq(taskNotes.noteId, noteId))
    .all()
    .map((r) => r.taskId)

  if (taskIds.length === 0) {
    return []
  }

  return db
    .select()
    .from(tasks)
    .where(sql`${tasks.id} IN ${taskIds}`)
    .all()
}

// ============================================================================
// Bulk Operations
// ============================================================================

/**
 * Bulk complete tasks.
 */
export function bulkCompleteTasks(db: DrizzleDb, ids: string[]): number {
  if (ids.length === 0) return 0

  const now = new Date().toISOString()
  const result = db
    .update(tasks)
    .set({ completedAt: now, modifiedAt: now })
    .where(sql`${tasks.id} IN ${ids}`)
    .run()

  return result.changes
}

/**
 * Bulk delete tasks.
 */
export function bulkDeleteTasks(db: DrizzleDb, ids: string[]): number {
  if (ids.length === 0) return 0

  const result = db
    .delete(tasks)
    .where(sql`${tasks.id} IN ${ids}`)
    .run()

  return result.changes
}

/**
 * Bulk move tasks to a project.
 */
export function bulkMoveTasks(db: DrizzleDb, ids: string[], projectId: string): number {
  if (ids.length === 0) return 0

  const result = db
    .update(tasks)
    .set({ projectId, modifiedAt: new Date().toISOString() })
    .where(sql`${tasks.id} IN ${ids}`)
    .run()

  return result.changes
}

/**
 * Bulk archive tasks.
 */
export function bulkArchiveTasks(db: DrizzleDb, ids: string[]): number {
  if (ids.length === 0) return 0

  const now = new Date().toISOString()
  const result = db
    .update(tasks)
    .set({ archivedAt: now, modifiedAt: now })
    .where(sql`${tasks.id} IN ${ids}`)
    .run()

  return result.changes
}

// ============================================================================
// Statistics
// ============================================================================

/**
 * Get task statistics.
 */
export function getTaskStats(db: DrizzleDb): {
  total: number
  completed: number
  overdue: number
  dueToday: number
  dueThisWeek: number
} {
  const today = getTodayDate()
  const weekFromNow = new Date()
  weekFromNow.setDate(weekFromNow.getDate() + 7)
  const weekFromNowStr = toLocalDateStr(weekFromNow)

  const result = db
    .select({
      total: count(),
      completed: sql<number>`sum(case when ${tasks.completedAt} is not null then 1 else 0 end)`,
      overdue: sql<number>`sum(case when ${tasks.dueDate} < ${today} and ${tasks.completedAt} is null then 1 else 0 end)`,
      dueToday: sql<number>`sum(case when ${tasks.dueDate} = ${today} and ${tasks.completedAt} is null then 1 else 0 end)`,
      dueThisWeek: sql<number>`sum(case when ${tasks.dueDate} >= ${today} and ${tasks.dueDate} <= ${weekFromNowStr} and ${tasks.completedAt} is null then 1 else 0 end)`
    })
    .from(tasks)
    .where(isNull(tasks.archivedAt))
    .get()

  return {
    total: result?.total ?? 0,
    completed: result?.completed ?? 0,
    overdue: result?.overdue ?? 0,
    dueToday: result?.dueToday ?? 0,
    dueThisWeek: result?.dueThisWeek ?? 0
  }
}

/**
 * Get the next available position for a new task in a project.
 */
export function getNextTaskPosition(
  db: DrizzleDb,
  projectId: string,
  parentId?: string | null
): number {
  const conditions: SQL<unknown>[] = [eq(tasks.projectId, projectId)]

  if (parentId !== undefined) {
    if (parentId === null) {
      conditions.push(isNull(tasks.parentId))
    } else {
      conditions.push(eq(tasks.parentId, parentId))
    }
  }

  const result = db
    .select({ maxPosition: sql<number>`max(${tasks.position})` })
    .from(tasks)
    .where(and(...conditions))
    .get()

  return (result?.maxPosition ?? -1) + 1
}
