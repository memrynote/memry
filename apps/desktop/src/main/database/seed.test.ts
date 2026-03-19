import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq, isNotNull, isNull } from 'drizzle-orm'
import { seedDefaults, seedSampleTasks } from './seed'
import { projects, statuses, tasks, taskTags, tagDefinitions } from '@memry/db-schema/schema'
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
      // #given
      seedDefaults(testDb.db)

      // #when
      const inboxProject = testDb.db.select().from(projects).where(eq(projects.id, 'inbox')).get()

      // #then
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
      // #given
      seedDefaults(testDb.db)

      // #when
      seedDefaults(testDb.db)

      // #then
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

    it('creates 4 sample projects with statuses', () => {
      // #given / #when
      seedSampleTasks(testDb.db)

      // #then
      const sampleProjects = testDb.db
        .select()
        .from(projects)
        .where(eq(projects.isInbox, false))
        .all()

      expect(sampleProjects).toHaveLength(4)

      const projectNames = sampleProjects.map((p) => p.name)
      expect(projectNames).toContain('Product Launch')
      expect(projectNames).toContain('Home Renovation')
      expect(projectNames).toContain('Fitness & Wellness')
      expect(projectNames).toContain('Side Project')

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

    it('creates ~80 tasks across all projects', () => {
      // #given / #when
      seedSampleTasks(testDb.db)

      // #then
      const allTasks = testDb.db.select().from(tasks).all()

      expect(allTasks.length).toBeGreaterThanOrEqual(75)
      expect(allTasks.length).toBeLessThanOrEqual(85)
    })

    it('creates tasks with subtasks linked to parents', () => {
      // #given / #when
      seedSampleTasks(testDb.db)

      // #then
      const parentTasks = testDb.db.select().from(tasks).where(isNull(tasks.parentId)).all()
      const subtasks = testDb.db.select().from(tasks).where(isNotNull(tasks.parentId)).all()

      expect(parentTasks.length).toBeGreaterThan(0)
      expect(subtasks.length).toBeGreaterThanOrEqual(9)

      for (const sub of subtasks) {
        const parent = testDb.db.select().from(tasks).where(eq(tasks.id, sub.parentId!)).get()
        expect(parent).toBeDefined()
      }
    })

    it('creates tasks with tags and tag definitions', () => {
      // #given / #when
      seedSampleTasks(testDb.db)

      // #then
      const allTags = testDb.db.select().from(taskTags).all()
      expect(allTags.length).toBeGreaterThan(50)

      const allTagDefs = testDb.db.select().from(tagDefinitions).all()
      expect(allTagDefs.length).toBeGreaterThan(20)

      for (const def of allTagDefs) {
        expect(def.color).toMatch(/^#[0-9a-fA-F]{6}$/)
      }
    })

    it('creates tasks with various due dates including today', () => {
      // #given / #when
      seedSampleTasks(testDb.db)

      // #then
      const tasksWithDueDate = testDb.db.select().from(tasks).where(isNotNull(tasks.dueDate)).all()
      expect(tasksWithDueDate.length).toBeGreaterThan(30)

      const today = new Date().toISOString().split('T')[0]
      const todayTasks = tasksWithDueDate.filter((t) => t.dueDate === today)
      expect(todayTasks.length).toBeGreaterThan(0)
    })

    it('creates completed tasks with completedAt timestamps', () => {
      // #given / #when
      seedSampleTasks(testDb.db)

      // #then
      const completedTasks = testDb.db
        .select()
        .from(tasks)
        .where(isNotNull(tasks.completedAt))
        .all()

      expect(completedTasks.length).toBeGreaterThanOrEqual(16)
    })

    it('distributes tasks across all priority levels', () => {
      // #given / #when
      seedSampleTasks(testDb.db)

      // #then
      const allTasks = testDb.db.select().from(tasks).all()
      const priorities = new Set(allTasks.map((t) => t.priority))

      expect(priorities).toContain(0)
      expect(priorities).toContain(1)
      expect(priorities).toContain(2)
      expect(priorities).toContain(3)
    })

    it('creates repeatable tasks with repeatConfig', () => {
      // #given / #when
      seedSampleTasks(testDb.db)

      // #then
      const repeatableTasks = testDb.db
        .select()
        .from(tasks)
        .where(isNotNull(tasks.repeatConfig))
        .all()

      expect(repeatableTasks.length).toBeGreaterThanOrEqual(10)

      for (const task of repeatableTasks) {
        expect(task.repeatFrom).toBeTruthy()
        const config = task.repeatConfig as Record<string, unknown>
        expect(config.frequency).toBeDefined()
        expect(config.interval).toBeDefined()
        expect(config.endType).toBeDefined()
      }
    })

    it('distributes tasks across all 3 statuses per project', () => {
      // #given / #when
      seedSampleTasks(testDb.db)

      // #then
      const sampleProjects = testDb.db
        .select()
        .from(projects)
        .where(eq(projects.isInbox, false))
        .all()

      for (const project of sampleProjects) {
        const projectStatuses = testDb.db
          .select()
          .from(statuses)
          .where(eq(statuses.projectId, project.id))
          .all()

        for (const status of projectStatuses) {
          const statusTasks = testDb.db
            .select()
            .from(tasks)
            .where(eq(tasks.statusId, status.id))
            .all()

          expect(statusTasks.length).toBeGreaterThan(0)
        }
      }
    })

    it('is idempotent when seeding sample tasks', () => {
      // #given
      seedSampleTasks(testDb.db)
      const firstCount = testDb.db.select().from(tasks).all().length

      // #when
      seedSampleTasks(testDb.db)
      const secondCount = testDb.db.select().from(tasks).all().length

      // #then
      expect(firstCount).toBe(secondCount)

      const projectCount = testDb.db
        .select()
        .from(projects)
        .where(eq(projects.isInbox, false))
        .all().length

      expect(projectCount).toBe(4)
    })
  })
})
