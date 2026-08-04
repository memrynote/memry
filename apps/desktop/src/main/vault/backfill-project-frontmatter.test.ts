import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { TestDatabaseResult, TestDb } from '@tests/utils/test-db'
import { createTestDataDb, asClientDb, sql } from '@tests/utils/test-db'
import { noteMetadata } from '@memry/db-schema/schema/note-metadata'
import { insertProject, insertProjectLink } from '@main/database/queries/projects'
import { getSetting } from '@main/database/queries/settings'

/**
 * A fake vault: `diskFiles` is the file the note actually has on disk,
 * `cacheRecords` is what the index cache remembers about it. The two are kept
 * deliberately separate because the whole point of the read half is that the
 * cache can be stale — `indexFile` skips known paths without comparing mtimes,
 * so a note edited outside Memry while the app was closed has a stale cached
 * record and a fresh file.
 *
 * `writes` records the property record handed to `setEntityProperties`, which is
 * what `updateNote` assigns to the frontmatter wholesale — so asserting on it is
 * asserting on the bytes the user ends up with.
 */
const diskFiles = new Map<string, string>()
const cacheRecords = new Map<string, Record<string, unknown>>()
const cachedTags = new Map<string, string[]>()
const writes = new Map<string, Record<string, unknown>[]>()
const unwritable = new Set<string>()
const rejecting = new Set<string>()
let indexAvailable = true

vi.mock('../notes/entity-properties', () => ({
  getEntityPropertiesRecord: (id: string) => cacheRecords.get(id) ?? null,
  setEntityProperties: async (id: string, properties: Record<string, unknown>) => {
    writes.set(id, [...(writes.get(id) ?? []), properties])
    if (unwritable.has(id)) throw new Error('EACCES')
    if (rejecting.has(id)) return { success: false, error: 'Entity not found' }
    cacheRecords.set(id, properties)
    return { success: true }
  }
}))
vi.mock('../notes/store', () => ({
  getNoteCacheById: (_db: unknown, id: string) =>
    cacheRecords.has(id) ? { id, path: `notes/${id}.md`, date: null } : undefined,
  getNoteTags: (_db: unknown, id: string) => cachedTags.get(id) ?? []
}))
vi.mock('./notes-io', () => ({
  toAbsolutePath: (relativePath: string) => `/vault/${relativePath}`
}))
vi.mock('./file-ops', () => ({
  safeRead: (absolutePath: string) =>
    Promise.resolve(diskFiles.get(absolutePath.replace('/vault/', '')) ?? null)
}))
vi.mock('../database', () => ({
  getIndexDatabase: () => ({ kind: 'index-db' }),
  isIndexDatabaseInitialized: () => indexAvailable
}))
vi.mock('../lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))

// `./frontmatter` is deliberately NOT mocked: the parse of the file the fake
// vault holds is the real one.
import {
  snapshotProjectFrontmatterBackfill,
  applyProjectFrontmatterBackfill,
  PROJECT_FRONTMATTER_BACKFILL_KEY
} from './backfill-project-frontmatter'

const BASE_TIME = '2026-01-15T10:00:00.000Z'

/** A Memry-written note: user properties live under a nested `properties:` block. */
const memryFile = (properties: Record<string, unknown>, tags?: string[]): string => {
  const tagLine = tags ? `tags: ${JSON.stringify(tags)}\n` : ''
  return `---\n${tagLine}properties: ${JSON.stringify(properties)}\n---\n\nBody\n`
}

describe('project frontmatter backfill', () => {
  let dbResult: TestDatabaseResult
  let db: TestDb

  beforeEach(() => {
    dbResult = createTestDataDb()
    db = dbResult.db
    diskFiles.clear()
    cacheRecords.clear()
    cachedTags.clear()
    writes.clear()
    unwritable.clear()
    rejecting.clear()
    indexAvailable = true
  })

  afterEach(() => {
    dbResult.close()
  })

  const seedProject = (id: string, name: string, position = 0): void => {
    insertProject(asClientDb(db), { id, name, color: '#000', position, isInbox: false })
  }

  /**
   * A row in `note_metadata`, its cached property record, and its file. `cached`
   * defaults to the file's properties, i.e. an index cache that is up to date.
   */
  const seedNote = (
    id: string,
    fileType: string,
    options: { file?: string; cached?: Record<string, unknown>; onDisk?: boolean } = {}
  ): void => {
    const extension = fileType === 'markdown' ? 'md' : 'pdf'
    db.insert(noteMetadata)
      .values({
        id,
        path: `notes/${id}.${extension}`,
        title: id,
        fileType: fileType as never,
        createdAt: BASE_TIME,
        modifiedAt: BASE_TIME
      })
      .run()

    const file = options.file ?? memryFile(options.cached ?? {})
    if (options.onDisk !== false) diskFiles.set(`notes/${id}.md`, file)
    cacheRecords.set(id, options.cached ?? {})
  }

  const seedLink = (linkId: string, projectId: string, itemType: string, itemId: string): void => {
    insertProjectLink(asClientDb(db), { id: linkId, projectId, itemType, itemId })
  }

  const runBackfill = async (): Promise<void> => {
    snapshotProjectFrontmatterBackfill(asClientDb(db))
    await applyProjectFrontmatterBackfill(asClientDb(db))
  }

  const written = (id: string): Record<string, unknown> | undefined => writes.get(id)?.at(-1)
  const writeCount = (id: string): number => writes.get(id)?.length ?? 0
  const marker = (): string | null => getSetting(asClientDb(db), PROJECT_FRONTMATTER_BACKFILL_KEY)

  it("writes the project name onto a markdown note that has a ('note', id) link and no project key", async () => {
    seedProject('p1', 'Alpha')
    seedNote('n1', 'markdown')
    seedLink('l1', 'p1', 'note', 'n1')

    await runBackfill()

    expect(written('n1')).toEqual({ project: ['Alpha'] })
  })

  // The population this backfill exists for: the project hub's file importer
  // wrote item_type 'file' even for an imported .md.
  it("writes the project name onto a markdown note whose link is a legacy ('file', id) row", async () => {
    seedProject('p1', 'Alpha')
    seedNote('n1', 'markdown')
    seedLink('l1', 'p1', 'file', 'n1')

    await runBackfill()

    expect(written('n1')).toEqual({ project: ['Alpha'] })
  })

  it('leaves a note that already names the project untouched, with no redundant write', async () => {
    seedProject('p1', 'Alpha')
    seedNote('n1', 'markdown', { cached: { project: 'Alpha', Status: 'Draft' } })
    seedLink('l1', 'p1', 'note', 'n1')

    await runBackfill()

    expect(writeCount('n1')).toBe(0)
  })

  it('matches an existing name case-insensitively rather than adding a duplicate', async () => {
    seedProject('p1', 'Alpha')
    seedNote('n1', 'markdown', { cached: { project: ['alpha'] } })
    seedLink('l1', 'p1', 'note', 'n1')

    await runBackfill()

    expect(writeCount('n1')).toBe(0)
  })

  it('adds the new name to a note that already names a different project', async () => {
    seedProject('p1', 'Alpha')
    seedNote('n1', 'markdown', { cached: { project: ['Beta'] } })
    seedLink('l1', 'p1', 'note', 'n1')

    await runBackfill()

    expect(written('n1')).toEqual({ project: ['Beta', 'Alpha'] })
  })

  it("preserves the note's other properties", async () => {
    seedProject('p1', 'Alpha')
    seedNote('n1', 'markdown', { cached: { Status: 'Draft', Rating: 4 } })
    seedLink('l1', 'p1', 'note', 'n1')

    await runBackfill()

    expect(written('n1')).toEqual({ Status: 'Draft', Rating: 4, project: ['Alpha'] })
  })

  // The backfill runs unattended at startup on files the user never opened, and
  // `updateNote` assigns the property record wholesale. Basing it on the index
  // cache would delete the key the user added offline and revert the one they
  // changed — and then sync that revert to every device.
  it('builds the write from the file on disk, not from a stale index cache', async () => {
    seedProject('p1', 'Alpha')
    seedNote('n1', 'markdown', {
      // Edited in another editor while Memry was closed: `Status` added,
      // `rating` changed from 5 to 4. `indexFile` skipped the known path, so the
      // cache still holds the old set.
      file: memryFile({ rating: 4, Status: 'Reviewed' }),
      cached: { rating: 5 }
    })
    seedLink('l1', 'p1', 'note', 'n1')

    await runBackfill()

    expect(written('n1')).toEqual({ rating: 4, Status: 'Reviewed', project: ['Alpha'] })
  })

  it('sees a project name that only the on-disk file carries and writes nothing', async () => {
    seedProject('p1', 'Alpha')
    seedNote('n1', 'markdown', { file: memryFile({ project: ['Alpha'] }), cached: {} })
    seedLink('l1', 'p1', 'note', 'n1')

    await runBackfill()

    expect(writeCount('n1')).toBe(0)
  })

  it('falls back to the cached record when the file cannot be read', async () => {
    seedProject('p1', 'Alpha')
    seedNote('n1', 'markdown', { cached: { Status: 'Draft' }, onDisk: false })
    seedLink('l1', 'p1', 'note', 'n1')

    await runBackfill()

    expect(written('n1')).toEqual({ Status: 'Draft', project: ['Alpha'] })
  })

  // `parseNote` keeps an unparseable block verbatim so a writeback cannot
  // destroy it, but `updateNote` re-stringifies from the parsed object — which
  // is empty here. Writing would replace the user's YAML with nothing.
  it('skips a note whose frontmatter cannot be parsed', async () => {
    seedProject('p1', 'Alpha')
    seedNote('n1', 'markdown', { file: '---\nbroken: [unclosed\n---\n\nBody\n' })
    seedLink('l1', 'p1', 'note', 'n1')

    await runBackfill()

    expect(writeCount('n1')).toBe(0)
    expect(marker()).toBe('done')
  })

  // `updateNote` takes tags from the index cache and never from the file, and
  // `setEntityProperties` has no way to pass them — so writing a note that was
  // tagged while the app was closed deletes that tag from the file. Verified
  // end-to-end against the real writer; see the task report.
  it('defers a note that carries a tag the index cache has never seen', async () => {
    seedProject('p1', 'Alpha')
    seedNote('n1', 'markdown', { file: memryFile({}, ['work']) })
    cachedTags.set('n1', [])
    seedLink('l1', 'p1', 'note', 'n1')

    await runBackfill()

    expect(writeCount('n1')).toBe(0)
    expect(marker()).toBe(JSON.stringify({ n1: ['Alpha'] }))

    // Once the note is reindexed the cache catches up and a later open writes it.
    cachedTags.set('n1', ['work'])
    await applyProjectFrontmatterBackfill(asClientDb(db))

    expect(written('n1')).toEqual({ project: ['Alpha'] })
    expect(marker()).toBe('done')
  })

  it('writes a note whose file tags the cache already knows', async () => {
    seedProject('p1', 'Alpha')
    seedNote('n1', 'markdown', { file: memryFile({}, ['Work']) })
    cachedTags.set('n1', ['work'])
    seedLink('l1', 'p1', 'note', 'n1')

    await runBackfill()

    expect(written('n1')).toEqual({ project: ['Alpha'] })
  })

  // The cached set legitimately holds tags found inline in the body, so it is a
  // superset of the file's frontmatter tags. That must not read as staleness.
  it('does not defer when the cache holds more tags than the file', async () => {
    seedProject('p1', 'Alpha')
    seedNote('n1', 'markdown', { file: memryFile({}, ['work']) })
    cachedTags.set('n1', ['work', 'inline-only'])
    seedLink('l1', 'p1', 'note', 'n1')

    await runBackfill()

    expect(written('n1')).toEqual({ project: ['Alpha'] })
  })

  it('writes a note linked to several projects exactly once', async () => {
    seedProject('p1', 'Alpha', 0)
    seedProject('p2', 'Beta', 1)
    seedNote('n1', 'markdown')
    seedLink('l1', 'p1', 'note', 'n1')
    seedLink('l2', 'p2', 'file', 'n1')

    await runBackfill()

    expect(writeCount('n1')).toBe(1)
    expect(written('n1')).toEqual({ project: ['Alpha', 'Beta'] })
  })

  it("ignores a binary file's link", async () => {
    seedProject('p1', 'Alpha')
    seedNote('f1', 'pdf')
    seedLink('l1', 'p1', 'file', 'f1')

    await runBackfill()

    expect(writeCount('f1')).toBe(0)
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

    expect(written('n1')).toEqual({ project: ['Alpha'] })
    expect(writeCount('n2')).toBe(0)
  })

  // Indexing has already run by the time the apply phase executes, so a note the
  // index cache does not know is a note that is not in the vault. Retrying it on
  // every later open would never succeed.
  it('drops a link whose note the index cache does not know, and still completes', async () => {
    seedProject('p1', 'Alpha')
    seedNote('n1', 'markdown')
    seedNote('n2', 'markdown')
    seedLink('l1', 'p1', 'note', 'n1')
    seedLink('l2', 'p1', 'note', 'n2')
    cacheRecords.delete('n2')

    await runBackfill()

    expect(written('n1')).toEqual({ project: ['Alpha'] })
    expect(writeCount('n2')).toBe(0)
    expect(marker()).toBe('done')
  })

  it('keeps going when one note throws on write, and keeps it pending', async () => {
    seedProject('p1', 'Alpha')
    seedNote('bad', 'markdown')
    seedNote('n2', 'markdown')
    seedLink('l1', 'p1', 'note', 'bad')
    seedLink('l2', 'p1', 'note', 'n2')
    unwritable.add('bad')

    await runBackfill()

    expect(written('n2')).toEqual({ project: ['Alpha'] })
    expect(marker()).toBe(JSON.stringify({ bad: ['Alpha'] }))

    // The next open retries only the note that failed.
    unwritable.delete('bad')
    await applyProjectFrontmatterBackfill(asClientDb(db))

    expect(written('bad')).toEqual({ project: ['Alpha'] })
    expect(writeCount('n2')).toBe(1)
    expect(marker()).toBe('done')
  })

  it('keeps a note pending when the write comes back as a failure envelope', async () => {
    seedProject('p1', 'Alpha')
    seedNote('gone', 'markdown')
    seedNote('n2', 'markdown')
    seedLink('l1', 'p1', 'note', 'gone')
    seedLink('l2', 'p1', 'note', 'n2')
    rejecting.add('gone')

    await runBackfill()

    expect(written('n2')).toEqual({ project: ['Alpha'] })
    expect(marker()).toBe(JSON.stringify({ gone: ['Alpha'] }))
  })

  // One failed index rebuild would otherwise run every note through the per-note
  // guard, count them all as handled, and mark the vault done — losing the whole
  // legacy-link population.
  it('defers the whole backfill when the index database is unavailable', async () => {
    seedProject('p1', 'Alpha')
    seedNote('n1', 'markdown')
    seedLink('l1', 'p1', 'note', 'n1')

    indexAvailable = false
    await runBackfill()

    expect(writeCount('n1')).toBe(0)
    expect(marker()).toBe(JSON.stringify({ n1: ['Alpha'] }))

    indexAvailable = true
    await applyProjectFrontmatterBackfill(asClientDb(db))

    expect(written('n1')).toEqual({ project: ['Alpha'] })
    expect(marker()).toBe('done')
  })

  it('writes nothing on a second run', async () => {
    seedProject('p1', 'Alpha')
    seedNote('n1', 'markdown')
    seedLink('l1', 'p1', 'note', 'n1')

    await runBackfill()
    expect(writeCount('n1')).toBe(1)

    await runBackfill()

    expect(writeCount('n1')).toBe(1)
  })

  it('does not re-snapshot links created after the backfill completed', async () => {
    seedProject('p1', 'Alpha')
    seedNote('n1', 'markdown')
    seedLink('l1', 'p1', 'note', 'n1')

    await runBackfill()

    seedNote('n2', 'markdown')
    seedLink('l2', 'p1', 'note', 'n2')

    await runBackfill()

    expect(writeCount('n2')).toBe(0)
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

    expect(written('n1')).toEqual({ project: ['Alpha'] })
  })

  it('marks the vault done so a later open skips both phases', async () => {
    seedProject('p1', 'Alpha')
    seedNote('n1', 'markdown')
    seedLink('l1', 'p1', 'note', 'n1')

    expect(marker()).toBeNull()

    await runBackfill()

    expect(marker()).toBe('done')
  })

  // A device provisioned by download or link has no `project_links` rows until
  // its first sync pulls them, and the sync runtime starts at the very end of
  // openVault — long after the snapshot phase. Marking such a vault done would
  // strand every link that arrives afterwards.
  it('does not mark a vault with no links done, and backfills them when they arrive', async () => {
    await runBackfill()

    expect(marker()).toBeNull()

    seedProject('p1', 'Alpha')
    seedNote('n1', 'markdown')
    seedLink('l1', 'p1', 'note', 'n1')

    await runBackfill()

    expect(written('n1')).toEqual({ project: ['Alpha'] })
    expect(marker()).toBe('done')
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
    expect(marker()).toBe('done')
  })
})
