import { asc, eq, inArray } from 'drizzle-orm'
import {
  projects,
  statuses,
  tasks,
  taskCanvases,
  taskNotes,
  taskTags
} from '@memry/db-schema/data-schema'
import type { DrizzleDb as DataDb } from '@memry/db-schema/drizzle-db'
import { createId } from './ids.ts'

export interface TaskRecord {
  id: string
  projectId: string
  statusId: string | null
  parentId: string | null
  title: string
  description: string | null
  priority: number
  position: number
  dueDate: string | null
  dueTime: string | null
  startDate: string | null
  repeatConfig: unknown | null
  repeatFrom: string | null
  sourceNoteId: string | null
  completedAt: string | null
  archivedAt: string | null
  createdAt: string
  modifiedAt: string
  tags: string[]
  linkedNoteIds: string[]
  linkedCanvasIds: string[]
}

export interface ProjectRecord {
  id: string
  name: string
  description: string | null
  color: string
  icon: string | null
  position: number
  isInbox: boolean
  createdAt: string
  modifiedAt: string
  archivedAt: string | null
}

export interface StatusRecord {
  id: string
  projectId: string
  name: string
  color: string
  position: number
  isDefault: boolean
  isDone: boolean
  createdAt: string
}

export interface TaskTagRecord {
  tag: string
  count: number
}

export interface TaskStats {
  total: number
  completed: number
  archived: number
  overdue: number
  dueToday: number
}

export interface CreateTaskInput {
  title: string
  description?: string | null
  projectId?: string
  statusId?: string | null
  parentId?: string | null
  dueDate?: string | null
  dueTime?: string | null
  startDate?: string | null
  repeatConfig?: unknown | null
  repeatFrom?: string | null
  sourceNoteId?: string | null
  priority?: number
  tags?: string[]
  linkedNoteIds?: string[]
  linkedCanvasIds?: string[]
}

export interface MoveTaskInput {
  projectId?: string
  statusId?: string | null
  parentId?: string | null
  position?: number
}

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
  sortBy?: 'modified' | 'created' | 'position' | 'priority' | 'dueDate'
  sortOrder?: 'asc' | 'desc'
  limit?: number
  offset?: number
}

export interface TasksService {
  create(input: CreateTaskInput): Promise<TaskRecord>
  get(id: string): Promise<TaskRecord | null>
  list(options?: ListTasksOptions): Promise<TaskRecord[]>
  update(id: string, updates: Partial<CreateTaskInput>): Promise<TaskRecord>
  complete(id: string): Promise<TaskRecord>
  reopen(id: string): Promise<TaskRecord>
  archive(id: string): Promise<TaskRecord>
  unarchive(id: string): Promise<TaskRecord>
  move(id: string, input: MoveTaskInput): Promise<TaskRecord>
  getSubtasks(parentId: string): Promise<TaskRecord[]>
  getLinkedTasks(noteId: string): Promise<TaskRecord[]>
  today(date?: string): Promise<TaskRecord[]>
  upcoming(options?: { days?: number; fromDate?: string }): Promise<TaskRecord[]>
  overdue(date?: string): Promise<TaskRecord[]>
  stats(date?: string): Promise<TaskStats>
  getTags(): Promise<TaskTagRecord[]>
  convertToSubtask(taskId: string, parentId: string): Promise<TaskRecord>
  convertToTask(id: string): Promise<TaskRecord>
  duplicate(id: string): Promise<TaskRecord>
  bulkComplete(ids: string[]): Promise<number>
  bulkArchive(ids: string[]): Promise<number>
  bulkMove(ids: string[], projectId: string): Promise<number>
  bulkDelete(ids: string[]): Promise<number>
  reorder(ids: string[], positions: number[]): Promise<boolean>
  delete(id: string): Promise<boolean>
  projects: {
    list(): Promise<ProjectRecord[]>
    get(id: string): Promise<ProjectRecord | null>
    create(input: {
      name: string
      description?: string | null
      color?: string
      icon?: string | null
    }): Promise<ProjectRecord>
    update(
      id: string,
      updates: { name?: string; description?: string | null; color?: string; icon?: string | null }
    ): Promise<ProjectRecord>
    archive(id: string): Promise<ProjectRecord>
    unarchive(id: string): Promise<ProjectRecord>
    delete(id: string): Promise<boolean>
    reorder(ids: string[], positions: number[]): Promise<boolean>
    statuses(projectId: string): Promise<StatusRecord[]>
    createStatus(
      projectId: string,
      input: { name: string; color?: string; isDone?: boolean }
    ): Promise<StatusRecord>
    updateStatus(
      id: string,
      updates: {
        name?: string
        color?: string
        position?: number
        isDefault?: boolean
        isDone?: boolean
      }
    ): Promise<StatusRecord | null>
    deleteStatus(id: string): Promise<boolean>
    reorderStatuses(ids: string[], positions: number[]): Promise<boolean>
  }
}

function nowIso(): string {
  return new Date().toISOString()
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`)
  value.setUTCDate(value.getUTCDate() + days)
  return value.toISOString().slice(0, 10)
}

function existingTaskIds(db: DataDb, ids: string[]): string[] {
  if (ids.length === 0) return []
  return db
    .select({ id: tasks.id })
    .from(tasks)
    .where(inArray(tasks.id, ids))
    .all()
    .map((task) => task.id)
}

function getTags(db: DataDb, taskId: string): string[] {
  return db
    .select()
    .from(taskTags)
    .where(eq(taskTags.taskId, taskId))
    .all()
    .map((row) => row.tag)
}

function setTags(db: DataDb, taskId: string, tags: string[]): void {
  db.delete(taskTags).where(eq(taskTags.taskId, taskId)).run()
  for (const tag of tags) {
    const normalized = tag.trim()
    if (!normalized) continue
    db.insert(taskTags).values({ taskId, tag: normalized }).onConflictDoNothing().run()
  }
}

function getLinkedNoteIds(db: DataDb, taskId: string): string[] {
  return db
    .select()
    .from(taskNotes)
    .where(eq(taskNotes.taskId, taskId))
    .all()
    .map((row) => row.noteId)
}

function setLinkedNoteIds(db: DataDb, taskId: string, noteIds: string[]): void {
  db.delete(taskNotes).where(eq(taskNotes.taskId, taskId)).run()
  for (const noteId of [...new Set(noteIds.map((id) => id.trim()).filter(Boolean))]) {
    db.insert(taskNotes).values({ taskId, noteId }).onConflictDoNothing().run()
  }
}

function getLinkedCanvasIds(db: DataDb, taskId: string): string[] {
  return db
    .select()
    .from(taskCanvases)
    .where(eq(taskCanvases.taskId, taskId))
    .all()
    .map((row) => row.canvasId)
}

function setLinkedCanvasIds(db: DataDb, taskId: string, canvasIds: string[]): void {
  db.delete(taskCanvases).where(eq(taskCanvases.taskId, taskId)).run()
  for (const canvasId of [...new Set(canvasIds.map((id) => id.trim()).filter(Boolean))]) {
    db.insert(taskCanvases).values({ taskId, canvasId }).onConflictDoNothing().run()
  }
}

function toTask(db: DataDb, row: typeof tasks.$inferSelect): TaskRecord {
  return {
    id: row.id,
    projectId: row.projectId,
    statusId: row.statusId,
    parentId: row.parentId,
    title: row.title,
    description: row.description,
    priority: row.priority,
    position: row.position,
    dueDate: row.dueDate,
    dueTime: row.dueTime,
    startDate: row.startDate,
    repeatConfig: row.repeatConfig ?? null,
    repeatFrom: row.repeatFrom,
    sourceNoteId: row.sourceNoteId,
    completedAt: row.completedAt,
    archivedAt: row.archivedAt,
    createdAt: row.createdAt,
    modifiedAt: row.modifiedAt,
    tags: getTags(db, row.id),
    linkedNoteIds: getLinkedNoteIds(db, row.id),
    linkedCanvasIds: getLinkedCanvasIds(db, row.id)
  }
}

function toProject(row: typeof projects.$inferSelect): ProjectRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    color: row.color,
    icon: row.icon,
    position: row.position,
    isInbox: row.isInbox,
    createdAt: row.createdAt,
    modifiedAt: row.modifiedAt,
    archivedAt: row.archivedAt
  }
}

function toStatus(row: typeof statuses.$inferSelect): StatusRecord {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    color: row.color,
    position: row.position,
    isDefault: row.isDefault,
    isDone: row.isDone,
    createdAt: row.createdAt
  }
}

function nextTaskPosition(db: DataDb, projectId: string): number {
  const rows = db.select().from(tasks).where(eq(tasks.projectId, projectId)).all()
  return rows.reduce((max, task) => Math.max(max, task.position), -1) + 1
}

function defaultStatusForProject(db: DataDb, projectId: string): string | null {
  const status =
    db
      .select()
      .from(statuses)
      .where(eq(statuses.projectId, projectId))
      .orderBy(asc(statuses.position))
      .get() ?? null
  return status?.id ?? null
}

export function createTasksService(dataDb: DataDb): TasksService {
  return {
    async create(input) {
      const projectId = input.projectId ?? 'inbox'
      const time = nowIso()
      const id = createId('task')
      dataDb
        .insert(tasks)
        .values({
          id,
          projectId,
          statusId: input.statusId ?? defaultStatusForProject(dataDb, projectId),
          parentId: input.parentId ?? null,
          title: input.title,
          description: input.description ?? null,
          priority: input.priority ?? 0,
          position: nextTaskPosition(dataDb, projectId),
          dueDate: input.dueDate ?? null,
          dueTime: input.dueTime ?? null,
          startDate: input.startDate ?? null,
          repeatConfig: input.repeatConfig ?? null,
          repeatFrom: input.repeatFrom ?? null,
          sourceNoteId: input.sourceNoteId ?? null,
          completedAt: null,
          archivedAt: null,
          createdAt: time,
          modifiedAt: time
        })
        .run()
      if (input.tags) setTags(dataDb, id, input.tags)
      if (input.linkedNoteIds) setLinkedNoteIds(dataDb, id, input.linkedNoteIds)
      if (input.linkedCanvasIds) setLinkedCanvasIds(dataDb, id, input.linkedCanvasIds)
      return this.get(id).then((task) => {
        if (!task) throw new Error('Task not found after create')
        return task
      })
    },

    async get(id) {
      const row = dataDb.select().from(tasks).where(eq(tasks.id, id)).get()
      return row ? toTask(dataDb, row) : null
    },

    async list(options = {}) {
      const rows = dataDb.select().from(tasks).orderBy(asc(tasks.position)).all()
      const search = options.search?.toLowerCase()
      const sorted = rows
        .filter((task) => options.includeCompleted || !task.completedAt)
        .filter((task) => options.includeArchived || !task.archivedAt)
        .filter((task) => options.projectId === undefined || task.projectId === options.projectId)
        .filter((task) => options.statusId === undefined || task.statusId === options.statusId)
        .filter((task) => options.parentId === undefined || task.parentId === options.parentId)
        .filter(
          (task) => options.dueBefore === undefined || (task.dueDate ?? '') <= options.dueBefore
        )
        .filter(
          (task) => options.dueAfter === undefined || (task.dueDate ?? '') >= options.dueAfter
        )
        .map((task) => toTask(dataDb, task))
        .filter(
          (task) =>
            !options.tags?.length || options.tags.every((tag) => task.tags.includes(tag.trim()))
        )
        .filter(
          (task) =>
            !search ||
            task.title.toLowerCase().includes(search) ||
            (task.description?.toLowerCase().includes(search) ?? false)
        )
        .sort((left, right) => {
          const sortBy = options.sortBy ?? 'position'
          const direction = options.sortOrder === 'desc' ? -1 : 1
          const leftValue =
            sortBy === 'created'
              ? left.createdAt
              : sortBy === 'modified'
                ? left.modifiedAt
                : sortBy === 'priority'
                  ? left.priority
                  : sortBy === 'dueDate'
                    ? (left.dueDate ?? '')
                    : left.position
          const rightValue =
            sortBy === 'created'
              ? right.createdAt
              : sortBy === 'modified'
                ? right.modifiedAt
                : sortBy === 'priority'
                  ? right.priority
                  : sortBy === 'dueDate'
                    ? (right.dueDate ?? '')
                    : right.position
          if (leftValue < rightValue) return -1 * direction
          if (leftValue > rightValue) return 1 * direction
          return 0
        })
      return sorted.slice(
        options.offset ?? 0,
        (options.offset ?? 0) + (options.limit ?? sorted.length)
      )
    },

    async update(id, updates) {
      const time = nowIso()
      const task = dataDb
        .update(tasks)
        .set({
          ...(updates.title !== undefined ? { title: updates.title } : {}),
          ...(updates.description !== undefined ? { description: updates.description } : {}),
          ...(updates.projectId !== undefined ? { projectId: updates.projectId } : {}),
          ...(updates.statusId !== undefined ? { statusId: updates.statusId } : {}),
          ...(updates.parentId !== undefined ? { parentId: updates.parentId } : {}),
          ...(updates.dueDate !== undefined ? { dueDate: updates.dueDate } : {}),
          ...(updates.dueTime !== undefined ? { dueTime: updates.dueTime } : {}),
          ...(updates.startDate !== undefined ? { startDate: updates.startDate } : {}),
          ...(updates.repeatConfig !== undefined ? { repeatConfig: updates.repeatConfig } : {}),
          ...(updates.repeatFrom !== undefined ? { repeatFrom: updates.repeatFrom } : {}),
          ...(updates.sourceNoteId !== undefined ? { sourceNoteId: updates.sourceNoteId } : {}),
          ...(updates.priority !== undefined ? { priority: updates.priority } : {}),
          modifiedAt: time
        })
        .where(eq(tasks.id, id))
        .returning()
        .get()
      if (!task) throw new Error(`Task not found: ${id}`)
      if (updates.tags !== undefined) setTags(dataDb, id, updates.tags)
      if (updates.linkedNoteIds !== undefined) {
        setLinkedNoteIds(dataDb, id, updates.linkedNoteIds)
      }
      if (updates.linkedCanvasIds !== undefined) {
        setLinkedCanvasIds(dataDb, id, updates.linkedCanvasIds)
      }
      return toTask(dataDb, task)
    },

    async complete(id) {
      const time = nowIso()
      const task = dataDb
        .update(tasks)
        .set({ completedAt: time, modifiedAt: time })
        .where(eq(tasks.id, id))
        .returning()
        .get()
      if (!task) throw new Error(`Task not found: ${id}`)
      return toTask(dataDb, task)
    },

    async reopen(id) {
      const time = nowIso()
      const task = dataDb
        .update(tasks)
        .set({ completedAt: null, modifiedAt: time })
        .where(eq(tasks.id, id))
        .returning()
        .get()
      if (!task) throw new Error(`Task not found: ${id}`)
      return toTask(dataDb, task)
    },

    async archive(id) {
      const time = nowIso()
      const task = dataDb
        .update(tasks)
        .set({ archivedAt: time, modifiedAt: time })
        .where(eq(tasks.id, id))
        .returning()
        .get()
      if (!task) throw new Error(`Task not found: ${id}`)
      return toTask(dataDb, task)
    },

    async unarchive(id) {
      const time = nowIso()
      const task = dataDb
        .update(tasks)
        .set({ archivedAt: null, modifiedAt: time })
        .where(eq(tasks.id, id))
        .returning()
        .get()
      if (!task) throw new Error(`Task not found: ${id}`)
      return toTask(dataDb, task)
    },

    async move(id, input) {
      const time = nowIso()
      const existing = await this.get(id)
      if (!existing) throw new Error(`Task not found: ${id}`)
      const projectId = input.projectId ?? existing.projectId
      const task = dataDb
        .update(tasks)
        .set({
          ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
          ...(input.statusId !== undefined ? { statusId: input.statusId } : {}),
          ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
          position: input.position ?? nextTaskPosition(dataDb, projectId),
          modifiedAt: time
        })
        .where(eq(tasks.id, id))
        .returning()
        .get()
      if (!task) throw new Error(`Task not found: ${id}`)
      return toTask(dataDb, task)
    },

    async getSubtasks(parentId) {
      return dataDb
        .select()
        .from(tasks)
        .where(eq(tasks.parentId, parentId))
        .orderBy(asc(tasks.position))
        .all()
        .map((task) => toTask(dataDb, task))
    },

    async getLinkedTasks(noteId) {
      const links = dataDb
        .select({ taskId: taskNotes.taskId })
        .from(taskNotes)
        .where(eq(taskNotes.noteId, noteId))
        .all()
      if (links.length === 0) return []
      return dataDb
        .select()
        .from(tasks)
        .where(
          inArray(
            tasks.id,
            links.map((link) => link.taskId)
          )
        )
        .orderBy(asc(tasks.position))
        .all()
        .map((task) => toTask(dataDb, task))
    },

    async today(date = todayIso()) {
      return this.list({ dueAfter: date, dueBefore: date })
    },

    async upcoming(options = {}) {
      const fromDate = options.fromDate ?? todayIso()
      return this.list({
        dueAfter: fromDate,
        dueBefore: addDays(fromDate, options.days ?? 7)
      })
    },

    async overdue(date = todayIso()) {
      return (await this.list()).filter((task) => task.dueDate !== null && task.dueDate < date)
    },

    async stats(date = todayIso()) {
      const all = await this.list({ includeArchived: true, includeCompleted: true })
      return {
        total: all.length,
        completed: all.filter((task) => task.completedAt !== null).length,
        archived: all.filter((task) => task.archivedAt !== null).length,
        overdue: all.filter(
          (task) => task.completedAt === null && task.dueDate !== null && task.dueDate < date
        ).length,
        dueToday: all.filter((task) => task.completedAt === null && task.dueDate === date).length
      }
    },

    async getTags() {
      const counts = new Map<string, number>()
      for (const row of dataDb.select().from(taskTags).all()) {
        counts.set(row.tag, (counts.get(row.tag) ?? 0) + 1)
      }
      return [...counts.entries()]
        .map(([tag, count]) => ({ tag, count }))
        .sort((left, right) => left.tag.localeCompare(right.tag))
    },

    async convertToSubtask(taskId, parentId) {
      return this.update(taskId, { parentId })
    },

    async convertToTask(id) {
      return this.update(id, { parentId: null })
    },

    async duplicate(id) {
      const original = await this.get(id)
      if (!original) throw new Error(`Task not found: ${id}`)
      const time = nowIso()
      const newId = createId('task')
      dataDb
        .insert(tasks)
        .values({
          id: newId,
          projectId: original.projectId,
          statusId: original.statusId,
          parentId: original.parentId,
          title: `Copy of ${original.title}`,
          description: original.description,
          priority: original.priority,
          position: nextTaskPosition(dataDb, original.projectId),
          dueDate: original.dueDate,
          dueTime: original.dueTime,
          startDate: original.startDate,
          repeatConfig: original.repeatConfig,
          repeatFrom: original.repeatFrom,
          sourceNoteId: original.sourceNoteId,
          completedAt: null,
          archivedAt: null,
          createdAt: time,
          modifiedAt: time
        })
        .run()
      setTags(dataDb, newId, original.tags)
      setLinkedNoteIds(dataDb, newId, original.linkedNoteIds)
      setLinkedCanvasIds(dataDb, newId, original.linkedCanvasIds)
      const duplicated = await this.get(newId)
      if (!duplicated) throw new Error('Task not found after duplicate')
      return duplicated
    },

    async bulkComplete(ids) {
      const existingIds = existingTaskIds(dataDb, ids)
      if (existingIds.length === 0) return 0
      const time = nowIso()
      dataDb
        .update(tasks)
        .set({ completedAt: time, modifiedAt: time })
        .where(inArray(tasks.id, existingIds))
        .run()
      return existingIds.length
    },

    async bulkArchive(ids) {
      const existingIds = existingTaskIds(dataDb, ids)
      if (existingIds.length === 0) return 0
      const time = nowIso()
      dataDb
        .update(tasks)
        .set({ archivedAt: time, modifiedAt: time })
        .where(inArray(tasks.id, existingIds))
        .run()
      return existingIds.length
    },

    async bulkMove(ids, projectId) {
      const existingIds = existingTaskIds(dataDb, ids)
      if (existingIds.length === 0) return 0
      const time = nowIso()
      dataDb
        .update(tasks)
        .set({
          projectId,
          statusId: defaultStatusForProject(dataDb, projectId),
          modifiedAt: time
        })
        .where(inArray(tasks.id, existingIds))
        .run()
      return existingIds.length
    },

    async bulkDelete(ids) {
      const existingIds = existingTaskIds(dataDb, ids)
      if (existingIds.length === 0) return 0
      dataDb.delete(tasks).where(inArray(tasks.id, existingIds)).run()
      return existingIds.length
    },

    async reorder(ids, positions) {
      if (ids.length !== positions.length) throw new Error('Task ids and positions must match')
      const time = nowIso()
      for (const [index, id] of ids.entries()) {
        dataDb
          .update(tasks)
          .set({ position: positions[index] ?? index, modifiedAt: time })
          .where(eq(tasks.id, id))
          .run()
      }
      return true
    },

    async delete(id) {
      dataDb.delete(tasks).where(eq(tasks.id, id)).run()
      return true
    },

    projects: {
      async list() {
        return dataDb.select().from(projects).orderBy(asc(projects.position)).all().map(toProject)
      },
      async get(id) {
        const project = dataDb.select().from(projects).where(eq(projects.id, id)).get()
        return project ? toProject(project) : null
      },
      async create(input) {
        const time = nowIso()
        const id = createId('project')
        const position = dataDb.select().from(projects).all().length
        dataDb
          .insert(projects)
          .values({
            id,
            name: input.name,
            description: input.description ?? null,
            color: input.color ?? '#6366f1',
            icon: input.icon ?? null,
            position,
            isInbox: false,
            createdAt: time,
            modifiedAt: time
          })
          .run()
        dataDb
          .insert(statuses)
          .values([
            {
              id: createId('status'),
              projectId: id,
              name: 'To Do',
              color: '#6b7280',
              position: 0,
              isDefault: true,
              isDone: false,
              createdAt: time
            },
            {
              id: createId('status'),
              projectId: id,
              name: 'In Progress',
              color: '#F59E0B',
              position: 1,
              isDefault: false,
              isDone: false,
              createdAt: time
            },
            {
              id: createId('status'),
              projectId: id,
              name: 'Done',
              color: '#22c55e',
              position: 2,
              isDefault: false,
              isDone: true,
              createdAt: time
            }
          ])
          .run()
        const project = dataDb.select().from(projects).where(eq(projects.id, id)).get()
        if (!project) throw new Error('Project not found after create')
        return toProject(project)
      },
      async update(id, updates) {
        const time = nowIso()
        const project = dataDb
          .update(projects)
          .set({
            ...(updates.name !== undefined ? { name: updates.name } : {}),
            ...(updates.description !== undefined ? { description: updates.description } : {}),
            ...(updates.color !== undefined ? { color: updates.color } : {}),
            ...(updates.icon !== undefined ? { icon: updates.icon } : {}),
            modifiedAt: time
          })
          .where(eq(projects.id, id))
          .returning()
          .get()
        if (!project) throw new Error(`Project not found: ${id}`)
        return toProject(project)
      },
      async archive(id) {
        const time = nowIso()
        const project = dataDb
          .update(projects)
          .set({ archivedAt: time, modifiedAt: time })
          .where(eq(projects.id, id))
          .returning()
          .get()
        if (!project) throw new Error(`Project not found: ${id}`)
        return toProject(project)
      },
      async unarchive(id) {
        const time = nowIso()
        const project = dataDb
          .update(projects)
          .set({ archivedAt: null, modifiedAt: time })
          .where(eq(projects.id, id))
          .returning()
          .get()
        if (!project) throw new Error(`Project not found: ${id}`)
        return toProject(project)
      },
      async delete(id) {
        dataDb.delete(projects).where(eq(projects.id, id)).run()
        return true
      },
      async reorder(ids, positions) {
        if (ids.length !== positions.length) throw new Error('Project ids and positions must match')
        const time = nowIso()
        for (const [index, id] of ids.entries()) {
          dataDb
            .update(projects)
            .set({ position: positions[index] ?? index, modifiedAt: time })
            .where(eq(projects.id, id))
            .run()
        }
        return true
      },
      async statuses(projectId) {
        return dataDb
          .select()
          .from(statuses)
          .where(eq(statuses.projectId, projectId))
          .orderBy(asc(statuses.position))
          .all()
          .map(toStatus)
      },
      async createStatus(projectId, input) {
        const row = dataDb
          .insert(statuses)
          .values({
            id: createId('status'),
            projectId,
            name: input.name,
            color: input.color ?? '#6b7280',
            position: (await this.statuses(projectId)).length,
            isDefault: false,
            isDone: input.isDone ?? false,
            createdAt: nowIso()
          })
          .returning()
          .get()
        return toStatus(row)
      },
      async updateStatus(id, updates) {
        const status = dataDb
          .update(statuses)
          .set({
            ...(updates.name !== undefined ? { name: updates.name } : {}),
            ...(updates.color !== undefined ? { color: updates.color } : {}),
            ...(updates.position !== undefined ? { position: updates.position } : {}),
            ...(updates.isDefault !== undefined ? { isDefault: updates.isDefault } : {}),
            ...(updates.isDone !== undefined ? { isDone: updates.isDone } : {})
          })
          .where(eq(statuses.id, id))
          .returning()
          .get()
        return status ? toStatus(status) : null
      },
      async deleteStatus(id) {
        dataDb.update(tasks).set({ statusId: null }).where(eq(tasks.statusId, id)).run()
        dataDb.delete(statuses).where(eq(statuses.id, id)).run()
        return true
      },
      async reorderStatuses(ids, positions) {
        if (ids.length !== positions.length) throw new Error('Status ids and positions must match')
        for (const [index, id] of ids.entries()) {
          dataDb
            .update(statuses)
            .set({ position: positions[index] ?? index })
            .where(eq(statuses.id, id))
            .run()
        }
        return true
      }
    }
  }
}
