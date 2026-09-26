/**
 * A note applied before the project its frontmatter names finds nothing to
 * link to. When that project lands from sync the link has to appear then, not
 * on some later re-pull of the note, and without pushing the project back.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createTestDataDb, createTestIndexDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { projectLinks } from '@memry/db-schema/schema/project-links'
import { noteMetadata } from '@memry/db-schema/schema/note-metadata'
import { noteCache, noteProperties } from '@memry/db-schema/schema/notes-cache'
import { syncIntents } from '@memry/db-schema/schema/sync-intents'
import type { ApplyContext, DrizzleDb } from '@memry/sync-client/item-handlers/types'

let dataDb: TestDatabaseResult
let indexDb: TestDatabaseResult

vi.mock('../../database', () => ({
  getDatabase: () => dataDb.db,
  getIndexDatabase: () => indexDb.db
}))

const mockLocalMutation = vi.fn()
vi.mock('../local-mutations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../local-mutations')>()),
  callLocalMutation: (...args: unknown[]) => mockLocalMutation(...args)
}))

import { projectHandler } from './project-handler'

const CREATED = '2026-09-23T10:00:00.000Z'

function seedNote(id: string, fileType: 'markdown' | 'pdf', project: string[] | null): void {
  dataDb.db
    .insert(noteMetadata)
    .values({ id, path: `${id}.md`, title: id, fileType, createdAt: CREATED, modifiedAt: CREATED })
    .run()
  indexDb.db
    .insert(noteCache)
    .values({ id, path: `${id}.md`, title: id, fileType, createdAt: CREATED, modifiedAt: CREATED })
    .run()
  if (project) {
    indexDb.db
      .insert(noteProperties)
      .values({ noteId: id, name: 'project', value: JSON.stringify(project), type: 'project' })
      .run()
  }
}

const linkRows = () =>
  dataDb.db
    .select({
      projectId: projectLinks.projectId,
      itemId: projectLinks.itemId,
      pinned: projectLinks.pinned
    })
    .from(projectLinks)
    .orderBy(projectLinks.itemId)
    .all()

describe('projectHandler.applyUpsert — notes that named the project first', () => {
  let ctx: ApplyContext

  beforeEach(() => {
    vi.clearAllMocks()
    dataDb = createTestDataDb()
    indexDb = createTestIndexDb()
    ctx = { db: dataDb.db as unknown as DrizzleDb, emit: vi.fn() }
  })

  afterEach(() => {
    dataDb.close()
    indexDb.close()
  })

  it('links markdown notes whose frontmatter names the new project, and pushes nothing', () => {
    seedNote('148lo0e3z34p', 'markdown', ['reading'])
    seedNote('uhk8j306lf5z', 'markdown', ['Other', 'Reading'])
    seedNote('unrelated001', 'markdown', ['Other'])
    seedNote('scan00000pdf', 'pdf', ['Reading'])

    const result = projectHandler.applyUpsert(
      ctx,
      'F-lvikiJ',
      {
        name: 'Reading',
        color: '#000',
        position: 0,
        links: [
          {
            id: 'link-from-origin',
            projectId: 'F-lvikiJ',
            itemType: 'note',
            itemId: 'uhk8j306lf5z',
            position: 3,
            pinned: 1
          }
        ],
        createdAt: CREATED,
        modifiedAt: CREATED
      },
      { 'device-64ae': 22 }
    )

    expect(result).toBe('applied')
    expect(linkRows()).toEqual([
      { projectId: 'F-lvikiJ', itemId: '148lo0e3z34p', pinned: 0 },
      { projectId: 'F-lvikiJ', itemId: 'uhk8j306lf5z', pinned: 1 }
    ])
    expect(mockLocalMutation).not.toHaveBeenCalled()
    expect(dataDb.db.select().from(syncIntents).all()).toEqual([])
  })
})
