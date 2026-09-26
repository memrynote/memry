/**
 * Two ingest paths publish `note.upserted` without reading the note's
 * frontmatter: the stat-only tier 0 (an external rename, a re-add of a
 * claimed path) and the large-file tier. The links projector must not read
 * their missing properties as "names no project".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { projects } from '@memry/db-schema/schema/projects'
import { projectLinks } from '@memry/db-schema/schema/project-links'
import { noteMetadata } from '@memry/db-schema/schema/note-metadata'
import { syncIntents } from '@memry/db-schema/schema/sync-intents'
import type { ProjectionEvent } from '../types'

let dataDb: TestDatabaseResult

vi.mock('../../database', () => ({
  getDatabase: () => dataDb.db,
  getIndexDatabase: () => ({})
}))

vi.mock('@main/database/queries/notes', () => ({
  extractDateFromPath: vi.fn(() => null),
  getNoteCacheByPath: vi.fn(() => undefined)
}))

const published: ProjectionEvent[] = []
vi.mock('../../projections', () => ({
  publishProjectionEvent: (event: ProjectionEvent) => published.push(event)
}))

const mockLocalMutation = vi.fn()
vi.mock('../../sync/local-mutations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../sync/local-mutations')>()),
  callLocalMutation: (...args: unknown[]) => mockLocalMutation(...args)
}))

import { syncLargeFileBodyToCache, syncNoteStatToCache } from '../../vault/note-sync'
import { createNoteProjectLinksProjector } from './note-project-links-projector'

const CREATED = '2026-01-01T00:00:00.000Z'

const linkRows = () =>
  dataDb.db
    .select({
      id: projectLinks.id,
      projectId: projectLinks.projectId,
      itemId: projectLinks.itemId,
      position: projectLinks.position,
      pinned: projectLinks.pinned
    })
    .from(projectLinks)
    .all()

async function projectPublished(): Promise<void> {
  const projector = createNoteProjectLinksProjector()
  for (const event of published.splice(0)) await projector.project(event)
}

describe('note-project-links projector — note.upserted with unread frontmatter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    published.length = 0
    dataDb = createTestDataDb()
    dataDb.db
      .insert(projects)
      .values({
        id: 'p1',
        name: 'Alpha',
        color: '#000',
        position: 0,
        isInbox: false,
        createdAt: CREATED,
        modifiedAt: CREATED
      })
      .run()
    dataDb.db
      .insert(noteMetadata)
      .values({
        id: 'n1',
        path: 'n1.md',
        title: 'n1',
        fileType: 'markdown',
        createdAt: CREATED,
        modifiedAt: CREATED
      })
      .run()
    dataDb.db
      .insert(projectLinks)
      .values({ id: 'l1', projectId: 'p1', itemType: 'note', itemId: 'n1', position: 4, pinned: 1 })
      .run()
  })

  afterEach(() => {
    dataDb.close()
  })

  it('an external rename keeps the link row and pushes nothing', async () => {
    syncNoteStatToCache(
      {} as never,
      {
        id: 'n1',
        path: 'renamed/n1.md',
        title: 'n1',
        createdAt: CREATED,
        modifiedAt: '2026-01-02T00:00:00.000Z',
        fileSize: 42
      },
      { isNew: false }
    )
    await projectPublished()

    expect(linkRows()).toEqual([
      { id: 'l1', projectId: 'p1', itemId: 'n1', position: 4, pinned: 1 }
    ])
    expect(mockLocalMutation).not.toHaveBeenCalled()
    expect(dataDb.db.select().from(syncIntents).all()).toEqual([])
  })

  it('a large-file ingest keeps the link row and pushes nothing', async () => {
    syncLargeFileBodyToCache({} as never, {
      id: 'n1',
      path: 'n1.md',
      title: 'n1',
      createdAt: CREATED,
      modifiedAt: '2026-01-02T00:00:00.000Z',
      wordCount: 900000,
      characterCount: 5000000,
      contentHash: 'hash-large',
      indexedHead: 'log line 1'
    })
    await projectPublished()

    expect(linkRows()).toEqual([
      { id: 'l1', projectId: 'p1', itemId: 'n1', position: 4, pinned: 1 }
    ])
    expect(mockLocalMutation).not.toHaveBeenCalled()
  })

  it('a read frontmatter without the project property still unlinks and pushes', async () => {
    await createNoteProjectLinksProjector().project({
      type: 'note.upserted',
      note: {
        kind: 'markdown',
        noteId: 'n1',
        path: 'n1.md',
        title: 'n1',
        fileType: 'markdown',
        localOnly: false,
        contentHash: 'hash-1',
        wordCount: 1,
        characterCount: 4,
        snippet: 'body',
        date: null,
        emoji: null,
        createdAt: CREATED,
        modifiedAt: '2026-01-02T00:00:00.000Z',
        parsedContent: 'body',
        tags: [],
        properties: {},
        wikiLinks: []
      }
    })

    expect(linkRows()).toEqual([])
    expect(mockLocalMutation.mock.calls).toEqual([['project', 'enqueueUpdate', 'p1', [['links']]]])
  })
})
