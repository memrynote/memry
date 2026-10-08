import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { noteCache } from '@memry/db-schema/schema/notes-cache'
import { noteMetadata } from '@memry/db-schema/schema/note-metadata'
import { asClientDb, createTestDatabases } from '@tests/utils/test-db'
import type { IndexDb } from '../database'
import { getProjectContents, insertProject, insertProjectLink } from '../database/queries/projects'
import { withoutMissingVaultItems } from './project-contents'

const NOW = '2026-10-01T00:00:00.000Z'

describe('withoutMissingVaultItems', () => {
  let dbs: ReturnType<typeof createTestDatabases>

  beforeEach(() => {
    dbs = createTestDatabases()
    insertProject(asClientDb(dbs.data.db), {
      id: 'p1',
      name: 'Project',
      color: '#6366f1',
      position: 0,
      isInbox: false
    })
  })

  afterEach(() => dbs.closeAll())

  const link = (id: string, fileType: 'markdown' | 'image', indexed: boolean): void => {
    const path = fileType === 'markdown' ? `${id}.md` : `${id}.png`
    const row = { id, path, title: id, fileType, createdAt: NOW, modifiedAt: NOW } as const
    dbs.data.db.insert(noteMetadata).values(row).run()
    if (indexed) dbs.index.db.insert(noteCache).values(row).run()
    insertProjectLink(asClientDb(dbs.data.db), {
      id: `link-${id}`,
      projectId: 'p1',
      itemType: fileType === 'markdown' ? 'note' : 'file',
      itemId: id
    })
  }

  // A file removed while the app was closed: the next launch drops its index
  // row, but its note_metadata row and project link stay behind (#2653).
  it('drops linked notes and files the vault index no longer holds', () => {
    link('kept-note', 'markdown', true)
    link('gone-note', 'markdown', false)
    link('kept-file', 'image', true)
    link('gone-file', 'image', false)

    const contents = withoutMissingVaultItems(
      dbs.index.db as unknown as IndexDb,
      getProjectContents(asClientDb(dbs.data.db), 'p1')
    )

    expect(contents.notes.map((n) => n.id)).toEqual(['kept-note'])
    expect(contents.files.map((f) => f.id)).toEqual(['kept-file'])
    expect(contents.counts).toEqual({ notes: 1, files: 1, events: 0 })
  })
})
