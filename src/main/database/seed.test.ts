import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq, isNotNull } from 'drizzle-orm'
import { seedDefaults, seedSampleTasks } from './seed'
import { projects, statuses, tasks, taskTags } from '@shared/db/schema'
import {
  createTestDatabase,
  cleanupTestDatabase,
  type TestDatabaseResult
} from '@tests/utils/test-db'

describe('database seed', () => {
  let testDb: TestDatabaseResult

  beforeEach(() => {
    testDb = createTestDatabase()
  })

  afterEach(() => {
    cleanupTestDatabase(testDb)
  })

  describe('seedDefaults', () => {
    it('creates the default inbox project and statuses', () => {
      seedDefaults(testDb.db)

      const inboxProject = testDb.db.select().from(projects).where(eq(projects.id, 'inbox')).get()

      expect(inboxProject).toBeDefined()
      expect(inboxProject?.isInbox).toBe(true)

      const inboxStatuses = testDb.db
        .select()
        .from(statuses)
        .where(eq(statuses.projectId, 'inbox'))
        .all()

      expect(inboxStatuses).toHaveLength(2)
    })

    it('is idempotent when seeding defaults', () => {
      seedDefaults(testDb.db)
      seedDefaults(testDb.db)

      const inboxProjects = testDb.db.select().from(projects).where(eq(projects.id, 'inbox')).all()

      const inboxStatuses = testDb.db
        .select()
        .from(statuses)
        .where(eq(statuses.projectId, 'inbox'))
        .all()

      expect(inboxProjects).toHaveLength(1)
      expect(inboxStatuses).toHaveLength(2)
    })
  })

  describe('seedSampleTasks', () => {
    beforeEach(() => {
      seedDefaults(testDb.db)
    })

    it('creates sample projects with statuses', () => {
      seedSampleTasks(testDb.db)

      const sampleProjects = testDb.db
        .select()
        .from(projects)
        .where(eq(projects.isInbox, false))
        .all()

      expect(sampleProjects).toHaveLength(3)

      const projectNames = sampleProjects.map((p) => p.name)
      expect(projectNames).toContain('Work')
      expect(projectNames).toContain('Personal')
      expect(projectNames).toContain('Learning')

      for (const project of sampleProjects) {
        const projectStatuses = testDb.db
          .select()
          .from(statuses)
          .where(eq(statuses.projectId, project.id))
          .all()

        expect(projectStatuses).toHaveLength(3)

        const statusNames = projectStatuses.map((s) => s.name)
        expect(statusNames).toContain('To Do')
        expect(statusNames).toContain('In Progress')
        expect(statusNames).toContain('Done')
      }
    })

    it('creates sample tasks with correct properties', () => {
      seedSampleTasks(testDb.db)

      const allTasks = testDb.db.select().from(tasks).all()

      expect(allTasks.length).toBeGreaterThanOrEqual(15)

      const parentTasks = allTasks.filter((t) => t.parentId === null)
      const subtasks = allTasks.filter((t) => t.parentId !== null)

      expect(parentTasks.length).toBeGreaterThan(0)
      expect(subtasks.length).toBeGreaterThan(0)
    })

    it('creates tasks with subtasks linked to parents', () => {
      seedSampleTasks(testDb.db)

      const groceryTask = testDb.db
        .select()
        .from(tasks)
        .where(eq(tasks.id, 'task-personal-1'))
        .get()

      expect(groceryTask).toBeDefined()
      expect(groceryTask?.title).toBe('Grocery shopping')

      const grocerySubtasks = testDb.db
        .select()
        .from(tasks)
        .where(eq(tasks.parentId, 'task-personal-1'))
        .all()

      expect(grocerySubtasks.length).toBe(3)
    })

    it('creates tasks with tags', () => {
      seedSampleTasks(testDb.db)

      const allTags = testDb.db.select().from(taskTags).all()

      expect(allTags.length).toBeGreaterThan(0)

      const urgentTags = allTags.filter((t) => t.tag === 'urgent')
      expect(urgentTags.length).toBeGreaterThan(0)
    })

    it('creates tasks with various due dates', () => {
      seedSampleTasks(testDb.db)

      const tasksWithDueDate = testDb.db.select().from(tasks).where(isNotNull(tasks.dueDate)).all()

      expect(tasksWithDueDate.length).toBeGreaterThan(0)

      const today = new Date().toISOString().split('T')[0]
      const todayTasks = tasksWithDueDate.filter((t) => t.dueDate === today)
      expect(todayTasks.length).toBeGreaterThan(0)
    })

    it('creates some completed tasks', () => {
      seedSampleTasks(testDb.db)

      const completedTasks = testDb.db
        .select()
        .from(tasks)
        .where(isNotNull(tasks.completedAt))
        .all()

      expect(completedTasks.length).toBeGreaterThan(0)
    })

    it('creates tasks with different priorities', () => {
      seedSampleTasks(testDb.db)

      const allTasks = testDb.db.select().from(tasks).all()

      const priorities = new Set(allTasks.map((t) => t.priority))
      expect(priorities.size).toBeGreaterThanOrEqual(3)
    })

    it('is idempotent when seeding sample tasks', () => {
      seedSampleTasks(testDb.db)
      const firstCount = testDb.db.select().from(tasks).all().length

      seedSampleTasks(testDb.db)
      const secondCount = testDb.db.select().from(tasks).all().length

      expect(firstCount).toBe(secondCount)

      const projectCount = testDb.db
        .select()
        .from(projects)
        .where(eq(projects.isInbox, false))
        .all().length

      expect(projectCount).toBe(3)
    })
  })
})
