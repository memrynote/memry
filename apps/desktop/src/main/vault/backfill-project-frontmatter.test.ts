import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { TestDatabaseResult, TestDb } from '@tests/utils/test-db'
import { createTestDataDb, asClientDb, sql } from '@tests/utils/test-db'
import { noteMetadata } from '@memry/db-schema/schema/note-metadata'
import { insertProject, insertProjectLink } from '@main/database/queries/projects'
import { getSetting } from '@main/database/queries/settings'

/**
 * The backfill's only writer is `setEntityProperties`; the test stands a fake
 * note store behind it so assertions are about the frontmatter that ends up on
 * each note, not about a mock having been called.
 */
const store = new Map<string, Record<string, unknown>>()
const writes = new Map<string, number>()
const unwritable = new Set<string>()
const rejecting = new Set<string>()

vi.mock('../notes/entity-properties', () => ({
  getEntityPropertiesRecord: (id: string) => store.get(id) ?? null,
  setEntityProperties: async (id: string, properties: Record<string, unknown>) => {
    writes.set(id, (writes.get(id) ?? 0) + 1)
    if (unwritable.has(id)) throw new Error('EACCES')
    if (rejecting.has(id)) return { success: false, error: 'Entity not found' }
    store.set(id, properties)
    return { success: true }
  }
}))
vi.mock('../lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))

import {
  snapshotProjectFrontmatterBackfill,
  applyProjectFrontmatterBackfill,
  PROJECT_FRONTMATTER_BACKFILL_KEY
} from './backfill-project-frontmatter'

const BASE_TIME = '2026-01-15T10:00:00.000Z'

describe('project frontmatter backfill', () => {
  let dbResult: TestDatabaseResult
  let db: TestDb

  beforeEach(() => {
    dbResult = createTestDataDb()
    db = dbResult.db
    store.clear()
    writes.clear()
    unwritable.clear()
    rejecting.clear()
  })

  afterEach(() => {
    dbResult.close()
  })

  const seedProject = (id: string, name: string, position = 0): void => {
    insertProject(asClientDb(db), { id, name, color: '#000', position, isInbox: false })
  }

  /** A row in `note_metadata` plus its current frontmatter properties. */
  const seedNote = (
    id: string,
    fileType: string,
    properties: Record<string, unknown> = {}
  ): void => {
    db.insert(noteMetadata)
      .values({
        id,
        path: `notes/${id}.${fileType === 'markdown' ? 'md' : 'pdf'}`,
        title: id,
        fileType: fileType as never,
        createdAt: BASE_TIME,
        modifiedAt: BASE_TIME
      })
      .run()
    store.set(id, properties)
  }

  const seedLink = (linkId: string, projectId: string, itemType: string, itemId: string): void => {
    insertProjectLink(asClientDb(db), { id: linkId, projectId, itemType, itemId })
  }

  const runBackfill = async (): Promise<void> => {
    snapshotProjectFrontmatterBackfill(asClientDb(db))
    await applyProjectFrontmatterBackfill(asClientDb(db))
  }

  it("writes the project name onto a markdown note that has a ('note', id) link and no project key", async () => {
    seedProject('p1', 'Alpha')
    seedNote('n1', 'markdown')
    seedLink('l1', 'p1', 'note', 'n1')

    await runBackfill()

    expect(store.get('n1')).toEqual({ project: ['Alpha'] })
  })

  // The population this backfill exists for: the project hub's file importer
  // wrote item_type 'file' even for an imported .md.
  it("writes the project name onto a markdown note whose link is a legacy ('file', id) row", async () => {
    seedProject('p1', 'Alpha')
    seedNote('n1', 'markdown')
    seedLink('l1', 'p1', 'file', 'n1')

    await runBackfill()

    expect(store.get('n1')).toEqual({ project: ['Alpha'] })
  })

  it('leaves a note that already names the project untouched, with no redundant write', async () => {
    seedProject('p1', 'Alpha')
    seedNote('n1', 'markdown', { project: 'Alpha', Status: 'Draft' })
    seedLink('l1', 'p1', 'note', 'n1')

    await runBackfill()

    expect(writes.get('n1')).toBeUndefined()
    expect(store.get('n1')).toEqual({ project: 'Alpha', Status: 'Draft' })
  })

  it('matches an existing name case-insensitively rather than adding a duplicate', async () => {
    seedProject('p1', 'Alpha')
    seedNote('n1', 'markdown', { project: ['alpha'] })
    seedLink('l1', 'p1', 'note', 'n1')

    await runBackfill()

    expect(writes.get('n1')).toBeUndefined()
    expect(store.get('n1')).toEqual({ project: ['alpha'] })
  })

  it('adds the new name to a note that already names a different project', async () => {
    seedProject('p1', 'Alpha')
    seedNote('n1', 'markdown', { project: ['Beta'] })
    seedLink('l1', 'p1', 'note', 'n1')

    await runBackfill()

    expect(store.get('n1')).toEqual({ project: ['Beta', 'Alpha'] })
  })

  it("preserves the note's other properties", async () => {
    seedProject('p1', 'Alpha')
    seedNote('n1', 'markdown', { Status: 'Draft', Rating: 4 })
    seedLink('l1', 'p1', 'note', 'n1')

    await runBackfill()

    expect(store.get('n1')).toEqual({ Status: 'Draft', Rating: 4, project: ['Alpha'] })
  })

  it('writes a note linked to several projects exactly once', async () => {
    seedProject('p1', 'Alpha', 0)
    seedProject('p2', 'Beta', 1)
    seedNote('n1', 'markdown')
    seedLink('l1', 'p1', 'note', 'n1')
    seedLink('l2', 'p2', 'file', 'n1')

    await runBackfill()

    expect(writes.get('n1')).toBe(1)
    expect(store.get('n1')).toEqual({ project: ['Alpha', 'Beta'] })
  })

  it("ignores a binary file's link", async () => {
    seedProject('p1', 'Alpha')
    seedNote('f1', 'pdf')
    seedLink('l1', 'p1', 'file', 'f1')

    await runBackfill()

    expect(writes.get('f1')).toBeUndefined()
    expect(store.get('f1')).toEqual({})
  })

  it('skips a link whose project no longer exists', async () => {
    seedProject('p1', 'Alpha')
    seedNote('n1', 'markdown')
    seedNote('n2', 'markdown')
    seedLink('l1', 'p1', 'note', 'n1')

    // A row orphaned before the FK constraint existed. Insert it with the
    // constraint suspended so the pre-existing shape is reproduced faithfully.
    dbResult.sqlite.pragma('foreign_keys = OFF')
    seedLink('l2', 'gone', 'note', 'n2')
    dbResult.sqlite.pragma('foreign_keys = ON')

    await runBackfill()

    expect(store.get('n1')).toEqual({ project: ['Alpha'] })
    expect(writes.get('n2')).toBeUndefined()
    expect(store.get('n2')).toEqual({})
  })

  it('skips a link whose note is missing from the property store', async () => {
    seedProject('p1', 'Alpha')
    seedNote('n1', 'markdown')
    seedNote('n2', 'markdown')
    seedLink('l1', 'p1', 'note', 'n1')
    seedLink('l2', 'p1', 'note', 'n2')
    store.delete('n2')

    await runBackfill()

    expect(store.get('n1')).toEqual({ project: ['Alpha'] })
    expect(writes.get('n2')).toBeUndefined()
  })

  it('keeps going when one note throws on write', async () => {
    seedProject('p1', 'Alpha')
    seedNote('bad', 'markdown')
    seedNote('n2', 'markdown')
    seedLink('l1', 'p1', 'note', 'bad')
    seedLink('l2', 'p1', 'note', 'n2')
    unwritable.add('bad')

    await runBackfill()

    expect(store.get('bad')).toEqual({})
    expect(store.get('n2')).toEqual({ project: ['Alpha'] })
  })

  it('keeps going when one note comes back as a failure envelope', async () => {
    seedProject('p1', 'Alpha')
    seedNote('gone', 'markdown')
    seedNote('n2', 'markdown')
    seedLink('l1', 'p1', 'note', 'gone')
    seedLink('l2', 'p1', 'note', 'n2')
    rejecting.add('gone')

    await runBackfill()

    expect(store.get('gone')).toEqual({})
    expect(store.get('n2')).toEqual({ project: ['Alpha'] })
  })

  it('writes nothing on a second run', async () => {
    seedProject('p1', 'Alpha')
    seedNote('n1', 'markdown')
    seedLink('l1', 'p1', 'note', 'n1')

    await runBackfill()
    expect(writes.get('n1')).toBe(1)

    await runBackfill()

    expect(writes.get('n1')).toBe(1)
    expect(store.get('n1')).toEqual({ project: ['Alpha'] })
  })

  it('does not re-snapshot links created after the backfill completed', async () => {
    seedProject('p1', 'Alpha')
    seedNote('n1', 'markdown')
    seedLink('l1', 'p1', 'note', 'n1')

    await runBackfill()

    seedNote('n2', 'markdown')
    seedLink('l2', 'p1', 'note', 'n2')

    await runBackfill()

    expect(writes.get('n2')).toBeUndefined()
    expect(store.get('n2')).toEqual({})
  })

  // The snapshot is taken before the projection runtime can reconcile rows away
  // and is persisted, so an index rebuild (or a kill) between the two phases
  // cannot cost the user a project membership.
  it('still backfills after the rows are deleted between snapshot and apply', async () => {
    seedProject('p1', 'Alpha')
    seedNote('n1', 'markdown')
    seedLink('l1', 'p1', 'note', 'n1')

    snapshotProjectFrontmatterBackfill(asClientDb(db))
    // The projector's delete, standing in for a full index rebuild.
    db.run(sql`DELETE FROM project_links`)
    await applyProjectFrontmatterBackfill(asClientDb(db))

    expect(store.get('n1')).toEqual({ project: ['Alpha'] })
  })

  it('marks the vault done so a later open skips both phases', async () => {
    seedProject('p1', 'Alpha')
    seedNote('n1', 'markdown')
    seedLink('l1', 'p1', 'note', 'n1')

    expect(getSetting(asClientDb(db), PROJECT_FRONTMATTER_BACKFILL_KEY)).toBeNull()

    await runBackfill()

    expect(getSetting(asClientDb(db), PROJECT_FRONTMATTER_BACKFILL_KEY)).toBe('done')
  })

  it('marks an empty vault done without writing anything', async () => {
    await runBackfill()

    expect(writes.size).toBe(0)
    expect(getSetting(asClientDb(db), PROJECT_FRONTMATTER_BACKFILL_KEY)).toBe('done')
  })

  it('recovers from an unreadable snapshot instead of retrying it forever', async () => {
    seedProject('p1', 'Alpha')
    seedNote('n1', 'markdown')
    seedLink('l1', 'p1', 'note', 'n1')

    db.run(
      sql`INSERT INTO settings (key, value, modified_at) VALUES (${PROJECT_FRONTMATTER_BACKFILL_KEY}, 'not json', ${BASE_TIME})`
    )

    await applyProjectFrontmatterBackfill(asClientDb(db))

    expect(writes.size).toBe(0)
    expect(getSetting(asClientDb(db), PROJECT_FRONTMATTER_BACKFILL_KEY)).toBe('done')
  })
})
