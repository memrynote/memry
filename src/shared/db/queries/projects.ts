/**
 * Project and Status query functions for Drizzle ORM.
 * These queries operate on data.db (source of truth for projects).
 *
 * @module db/queries/projects
 */

import { eq, asc, and, isNull, sql, count } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { projects, type Project, type NewProject } from '../schema/projects'
import { statuses, type Status, type NewStatus } from '../schema/statuses'
import { tasks } from '../schema/tasks'
import * as schema from '../schema'

type DrizzleDb = BetterSQLite3Database<typeof schema>

// ============================================================================
// Project CRUD
// ============================================================================

/**
 * Insert a new project.
 */
export function insertProject(db: DrizzleDb, project: NewProject): Project {
  return db.insert(projects).values(project).returning().get()
}

/**
 * Update an existing project.
 */
export function updateProject(
  db: DrizzleDb,
  id: string,
  updates: Partial<Omit<Project, 'id' | 'createdAt'>>
): Project | undefined {
  return db
    .update(projects)
    .set({
      ...updates,
      modifiedAt: new Date().toISOString()
    })
    .where(eq(projects.id, id))
    .returning()
    .get()
}

/**
 * Delete a project by ID.
 * Note: This will cascade delete all tasks and statuses in the project.
 */
export function deleteProject(db: DrizzleDb, id: string): void {
  // Don't allow deleting the inbox
  const project = getProjectById(db, id)
  if (project?.isInbox) {
    throw new Error('Cannot delete the inbox project')
  }

  db.delete(projects).where(eq(projects.id, id)).run()
}

/**
 * Get a project by ID.
 */
export function getProjectById(db: DrizzleDb, id: string): Project | undefined {
  return db.select().from(projects).where(eq(projects.id, id)).get()
}

/**
 * Check if a project exists.
 */
export function projectExists(db: DrizzleDb, id: string): boolean {
  const result = db.select({ id: projects.id }).from(projects).where(eq(projects.id, id)).get()
  return result !== undefined
}

/**
 * Get the inbox project.
 */
export function getInboxProject(db: DrizzleDb): Project | undefined {
  return db.select().from(projects).where(eq(projects.isInbox, true)).get()
}

// ============================================================================
// Project Listing
// ============================================================================

/**
 * List all projects (excluding archived by default).
 */
export function listProjects(db: DrizzleDb, includeArchived: boolean = false): Project[] {
  let query = db.select().from(projects)

  if (!includeArchived) {
    query = query.where(isNull(projects.archivedAt)) as typeof query
  }

  return query.orderBy(asc(projects.position)).all()
}

/**
 * Project with task statistics.
 */
export interface ProjectWithStats extends Project {
  taskCount: number
  completedCount: number
  overdueCount: number
}

/**
 * Get all projects with task statistics.
 */
export function getProjectsWithStats(db: DrizzleDb, includeArchived: boolean = false): ProjectWithStats[] {
  const today = new Date().toISOString().split('T')[0]

  // Get base projects
  const projectList = listProjects(db, includeArchived)

  // Get stats for each project
  return projectList.map((project) => {
    const stats = db
      .select({
        taskCount: count(),
        completedCount: sql<number>`sum(case when ${tasks.completedAt} is not null then 1 else 0 end)`,
        overdueCount: sql<number>`sum(case when ${tasks.dueDate} < ${today} and ${tasks.completedAt} is null then 1 else 0 end)`
      })
      .from(tasks)
      .where(and(eq(tasks.projectId, project.id), isNull(tasks.archivedAt)))
      .get()

    return {
      ...project,
      taskCount: stats?.taskCount ?? 0,
      completedCount: stats?.completedCount ?? 0,
      overdueCount: stats?.overdueCount ?? 0
    }
  })
}

// ============================================================================
// Project Actions
// ============================================================================

/**
 * Archive a project.
 */
export function archiveProject(db: DrizzleDb, id: string): Project | undefined {
  const project = getProjectById(db, id)
  if (project?.isInbox) {
    throw new Error('Cannot archive the inbox project')
  }

  return db
    .update(projects)
    .set({
      archivedAt: new Date().toISOString(),
      modifiedAt: new Date().toISOString()
    })
    .where(eq(projects.id, id))
    .returning()
    .get()
}

/**
 * Unarchive a project.
 */
export function unarchiveProject(db: DrizzleDb, id: string): Project | undefined {
  return db
    .update(projects)
    .set({
      archivedAt: null,
      modifiedAt: new Date().toISOString()
    })
    .where(eq(projects.id, id))
    .returning()
    .get()
}

/**
 * Reorder projects by updating their positions.
 */
export function reorderProjects(db: DrizzleDb, projectIds: string[], positions: number[]): void {
  if (projectIds.length !== positions.length) {
    throw new Error('projectIds and positions arrays must have the same length')
  }

  for (let i = 0; i < projectIds.length; i++) {
    db.update(projects)
      .set({
        position: positions[i],
        modifiedAt: new Date().toISOString()
      })
      .where(eq(projects.id, projectIds[i]))
      .run()
  }
}

/**
 * Get the next available position for a new project.
 */
export function getNextProjectPosition(db: DrizzleDb): number {
  const result = db
    .select({ maxPosition: sql<number>`max(${projects.position})` })
    .from(projects)
    .get()

  return (result?.maxPosition ?? -1) + 1
}

// ============================================================================
// Status CRUD
// ============================================================================

/**
 * Insert a new status.
 */
export function insertStatus(db: DrizzleDb, status: NewStatus): Status {
  return db.insert(statuses).values(status).returning().get()
}

/**
 * Update an existing status.
 */
export function updateStatus(
  db: DrizzleDb,
  id: string,
  updates: Partial<Omit<Status, 'id' | 'projectId' | 'createdAt'>>
): Status | undefined {
  return db.update(statuses).set(updates).where(eq(statuses.id, id)).returning().get()
}

/**
 * Delete a status by ID.
 * Tasks with this status will have their statusId set to null (onDelete: 'set null').
 */
export function deleteStatus(db: DrizzleDb, id: string): void {
  db.delete(statuses).where(eq(statuses.id, id)).run()
}

/**
 * Get a status by ID.
 */
export function getStatusById(db: DrizzleDb, id: string): Status | undefined {
  return db.select().from(statuses).where(eq(statuses.id, id)).get()
}

// ============================================================================
// Status Listing
// ============================================================================

/**
 * Get all statuses for a project.
 */
export function getStatusesByProject(db: DrizzleDb, projectId: string): Status[] {
  return db
    .select()
    .from(statuses)
    .where(eq(statuses.projectId, projectId))
    .orderBy(asc(statuses.position))
    .all()
}

/**
 * Get the default status for a project.
 */
export function getDefaultStatus(db: DrizzleDb, projectId: string): Status | undefined {
  return db
    .select()
    .from(statuses)
    .where(and(eq(statuses.projectId, projectId), eq(statuses.isDefault, true)))
    .get()
}

/**
 * Get the "done" status for a project.
 */
export function getDoneStatus(db: DrizzleDb, projectId: string): Status | undefined {
  return db
    .select()
    .from(statuses)
    .where(and(eq(statuses.projectId, projectId), eq(statuses.isDone, true)))
    .get()
}

/**
 * Get an equivalent status in a project based on status type.
 * Returns the first matching status or the default status as fallback.
 */
export function getEquivalentStatus(
  db: DrizzleDb,
  targetProjectId: string,
  sourceStatus: Status | undefined
): Status | undefined {
  if (!sourceStatus) {
    // No source status, return default
    return getDefaultStatus(db, targetProjectId)
  }

  // If source is a "done" status, find the done status in target project
  if (sourceStatus.isDone) {
    const doneStatus = getDoneStatus(db, targetProjectId)
    if (doneStatus) return doneStatus
  }

  // If source is the default/todo status, find the default in target project
  if (sourceStatus.isDefault) {
    const defaultStatus = getDefaultStatus(db, targetProjectId)
    if (defaultStatus) return defaultStatus
  }

  // For in-progress statuses, find a non-default, non-done status
  // or fall back to default
  const targetStatuses = getStatusesByProject(db, targetProjectId)
  const inProgressStatus = targetStatuses.find(s => !s.isDefault && !s.isDone)
  if (inProgressStatus) return inProgressStatus

  // Final fallback: return the default status
  return getDefaultStatus(db, targetProjectId)
}

// ============================================================================
// Status Actions
// ============================================================================

/**
 * Reorder statuses by updating their positions.
 */
export function reorderStatuses(db: DrizzleDb, statusIds: string[], positions: number[]): void {
  if (statusIds.length !== positions.length) {
    throw new Error('statusIds and positions arrays must have the same length')
  }

  for (let i = 0; i < statusIds.length; i++) {
    db.update(statuses).set({ position: positions[i] }).where(eq(statuses.id, statusIds[i])).run()
  }
}

/**
 * Get the next available position for a new status in a project.
 */
export function getNextStatusPosition(db: DrizzleDb, projectId: string): number {
  const result = db
    .select({ maxPosition: sql<number>`max(${statuses.position})` })
    .from(statuses)
    .where(eq(statuses.projectId, projectId))
    .get()

  return (result?.maxPosition ?? -1) + 1
}

/**
 * Set a status as the default for a project (unsets previous default).
 */
export function setDefaultStatus(db: DrizzleDb, projectId: string, statusId: string): void {
  // Unset current default
  db.update(statuses)
    .set({ isDefault: false })
    .where(and(eq(statuses.projectId, projectId), eq(statuses.isDefault, true)))
    .run()

  // Set new default
  db.update(statuses).set({ isDefault: true }).where(eq(statuses.id, statusId)).run()
}

/**
 * Set a status as the "done" status for a project (unsets previous done).
 */
export function setDoneStatus(db: DrizzleDb, projectId: string, statusId: string): void {
  // Unset current done status
  db.update(statuses)
    .set({ isDone: false })
    .where(and(eq(statuses.projectId, projectId), eq(statuses.isDone, true)))
    .run()

  // Set new done status
  db.update(statuses).set({ isDone: true }).where(eq(statuses.id, statusId)).run()
}

// ============================================================================
// Project with Statuses (Combined)
// ============================================================================

/**
 * Project with its statuses.
 */
export interface ProjectWithStatuses extends Project {
  statuses: Status[]
}

/**
 * Get a project with all its statuses.
 */
export function getProjectWithStatuses(db: DrizzleDb, id: string): ProjectWithStatuses | undefined {
  const project = getProjectById(db, id)
  if (!project) {
    return undefined
  }

  const projectStatuses = getStatusesByProject(db, id)

  return {
    ...project,
    statuses: projectStatuses
  }
}

/**
 * Get all projects with their statuses.
 */
export function getProjectsWithStatuses(
  db: DrizzleDb,
  includeArchived: boolean = false
): ProjectWithStatuses[] {
  const projectList = listProjects(db, includeArchived)

  return projectList.map((project) => ({
    ...project,
    statuses: getStatusesByProject(db, project.id)
  }))
}

// ============================================================================
// Bulk Operations
// ============================================================================

/**
 * Create default statuses for a new project.
 */
export function createDefaultStatuses(db: DrizzleDb, projectId: string): Status[] {
  const todoStatus = insertStatus(db, {
    id: `${projectId}-todo`,
    projectId,
    name: 'To Do',
    color: '#6b7280',
    position: 0,
    isDefault: true,
    isDone: false
  })

  const inProgressStatus = insertStatus(db, {
    id: `${projectId}-in-progress`,
    projectId,
    name: 'In Progress',
    color: '#3b82f6',
    position: 1,
    isDefault: false,
    isDone: false
  })

  const doneStatus = insertStatus(db, {
    id: `${projectId}-done`,
    projectId,
    name: 'Done',
    color: '#22c55e',
    position: 2,
    isDefault: false,
    isDone: true
  })

  return [todoStatus, inProgressStatus, doneStatus]
}

/**
 * Count tasks in a status.
 */
export function countTasksInStatus(db: DrizzleDb, statusId: string): number {
  const result = db
    .select({ count: count() })
    .from(tasks)
    .where(eq(tasks.statusId, statusId))
    .get()

  return result?.count ?? 0
}
