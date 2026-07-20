import { describe, it, expect, afterEach } from 'vitest'
import { createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { projects } from '@memry/db-schema/schema/projects'
import { projectLinks } from '@memry/db-schema/schema/project-links'
import { eq } from 'drizzle-orm'

describe('project_links schema', () => {
  let t: TestDatabaseResult
  afterEach(() => t?.close())

  it('#then stores a link and cascades on project delete', () => {
    t = createTestDataDb()
    t.db.insert(projects).values({ id: 'p1', name: 'P1', color: '#000', position: 0 }).run()
    t.db
      .insert(projectLinks)
      .values({ id: 'l1', projectId: 'p1', itemType: 'note', itemId: 'n1', position: 0 })
      .run()

    expect(t.db.select().from(projectLinks).all()).toHaveLength(1)

    t.db.delete(projects).where(eq(projects.id, 'p1')).run()
    expect(t.db.select().from(projectLinks).all()).toHaveLength(0)
  })

  it('#then projects.home_note_id is nullable and settable', () => {
    t = createTestDataDb()
    t.db.insert(projects).values({ id: 'p2', name: 'P2', color: '#000', position: 0 }).run()
    t.db.update(projects).set({ homeNoteId: 'note-9' }).where(eq(projects.id, 'p2')).run()
    const row = t.db.select().from(projects).where(eq(projects.id, 'p2')).get()
    expect(row?.homeNoteId).toBe('note-9')
  })
})
