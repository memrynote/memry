import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { seedDefaults } from './seed'
import { projects, statuses } from '@shared/db/schema'
import { createTestDatabase, cleanupTestDatabase, type TestDatabaseResult } from '@tests/utils/test-db'

describe('database seed', () => {
  let testDb: TestDatabaseResult

  beforeEach(() => {
    testDb = createTestDatabase()
  })

  afterEach(() => {
    cleanupTestDatabase(testDb)
  })

  it('creates the default inbox project and statuses', () => {
    seedDefaults(testDb.db)

    const inboxProject = testDb.db
      .select()
      .from(projects)
      .where(eq(projects.id, 'inbox'))
      .get()

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

    const inboxProjects = testDb.db
      .select()
      .from(projects)
      .where(eq(projects.id, 'inbox'))
      .all()

    const inboxStatuses = testDb.db
      .select()
      .from(statuses)
      .where(eq(statuses.projectId, 'inbox'))
      .all()

    expect(inboxProjects).toHaveLength(1)
    expect(inboxStatuses).toHaveLength(2)
  })
})
