/**
 * Vault-wide tag rename, merge and delete against read-only locks (#2606):
 * a locked note keeps its tags in the index as well as in its file, so the
 * index never disagrees with the locked file.
 *
 * @module ipc/tags-handlers-vault-locks.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mockIpcMain, resetIpcMocks, invokeHandler } from '@tests/utils/mock-ipc'
import { TagsChannels } from '@memry/contracts/ipc-channels'
import {
  asClientDb,
  createTestDataDb,
  createTestIndexDb,
  sql,
  type TestDatabaseResult
} from '@tests/utils/test-db'
import { getNoteTags, insertNoteCache, setNoteTags } from '@main/database/queries/notes'

const state = vi.hoisted(() => ({ data: null as unknown, index: null as unknown }))

const notes = vi.hoisted(() => ({ updateNoteCommand: vi.fn(async () => undefined) }))

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: unknown) =>
      mockIpcMain.handle(channel, handler as Parameters<typeof mockIpcMain.handle>[1])
    ),
    removeHandler: vi.fn((channel: string) => mockIpcMain.removeHandler(channel))
  },
  BrowserWindow: { getAllWindows: vi.fn(() => []) }
}))

vi.mock('../database', () => ({
  getIndexDatabase: () => state.index,
  getDatabase: () => state.data,
  requireDatabase: () => state.data
}))

vi.mock('../notes/domain', () => notes)
vi.mock('../vault/notes', () => ({ getNoteById: vi.fn(async () => null) }))
vi.mock('../sync/crdt-provider', () => ({
  ORIGIN_LOCAL: 'local',
  getCrdtProvider: () => ({ getDoc: () => undefined })
}))
vi.mock('../telemetry/diagnostics', () => ({ trackMainError: vi.fn() }))
vi.mock('../telemetry/track', () => ({ trackMainEvent: vi.fn() }))
vi.mock('../tags/runtime-effects', () => ({
  syncMergedTagDefinitions: vi.fn(),
  syncTagDefinitionDelete: vi.fn(),
  syncTagDefinitionRename: vi.fn(),
  syncTagDefinitionUpdate: vi.fn(),
  syncTagCategoryCreate: vi.fn(),
  syncTagCategoryUpdate: vi.fn(),
  syncTagCategoryDelete: vi.fn(),
  commitTaskRetag: vi.fn((_db: unknown, retag: () => unknown) => retag())
}))

import { registerTagsHandlers, unregisterTagsHandlers } from './tags-handlers'
import { installVaultLockSource, invalidateVaultLocks } from '../vault-locks/registry'
import { writeLockRow } from '../vault-locks/store'

describe('tag rename, merge and delete leave locked notes alone (#2606)', () => {
  let data: TestDatabaseResult
  let index: TestDatabaseResult
  const paths: Record<string, string> = {
    'note-locked': 'locked/a.md',
    'note-own-lock': 'notes/own.md',
    'note-free': 'notes/free.md'
  }

  beforeEach(() => {
    resetIpcMocks()
    vi.clearAllMocks()
    data = createTestDataDb()
    index = createTestIndexDb()
    state.data = data.db
    state.index = index.db
    for (const [id, notePath] of Object.entries(paths)) {
      insertNoteCache(index.db, {
        id,
        path: notePath,
        title: id,
        contentHash: `hash-${id}`,
        wordCount: 0,
        characterCount: 0,
        createdAt: '2026-01-10T00:00:00.000Z',
        modifiedAt: '2026-01-12T00:00:00.000Z'
      })
      setNoteTags(index.db, id, { header: ['old'], inline: ['keep'] })
    }
    installVaultLockSource({
      dataDb: () => asClientDb(data.db),
      notePathOf: (noteId) => paths[noteId] ?? null,
      noteIdAtPath: (relativePath) =>
        Object.keys(paths).find((id) => paths[id] === relativePath) ?? null
    })
    writeLockRow(asClientDb(data.db), 'folder', 'locked', true)
    writeLockRow(asClientDb(data.db), 'note', 'note-own-lock', true)
    invalidateVaultLocks()
    registerTagsHandlers()
  })

  /** A locked note's rows, header flags included, must come back exactly as they were. */
  function rows(noteId: string): Array<{ tag: string; in_header: number | null }> {
    return index.db.all(
      sql`SELECT tag, in_header FROM note_tags WHERE note_id = ${noteId} ORDER BY position`
    )
  }
  const lockedRows = [
    { tag: 'old', in_header: 1 },
    { tag: 'keep', in_header: 0 }
  ]

  afterEach(() => {
    unregisterTagsHandlers()
    installVaultLockSource({ dataDb: () => null, notePathOf: () => null, noteIdAtPath: () => null })
    data.close()
    index.close()
  })

  it('rename keeps the old tag on locked notes and renames it on the free one', async () => {
    await invokeHandler(TagsChannels.invoke.RENAME_TAG, { oldName: 'old', newName: 'fresh' })

    expect(getNoteTags(index.db, 'note-free')).toEqual(['fresh', 'keep'])
    expect(rows('note-locked')).toEqual(lockedRows)
    expect(rows('note-own-lock')).toEqual(lockedRows)
    expect(notes.updateNoteCommand.mock.calls).toEqual([
      [{ id: 'note-free', headerTags: { rename: [{ from: 'old', to: 'fresh' }] } }]
    ])
  })

  it('delete keeps the tag on locked notes and removes it from the free one', async () => {
    await invokeHandler(TagsChannels.invoke.DELETE_TAG, 'old')

    expect(getNoteTags(index.db, 'note-free')).toEqual(['keep'])
    expect(rows('note-locked')).toEqual(lockedRows)
    expect(rows('note-own-lock')).toEqual(lockedRows)
  })

  it('merge keeps the source tag on locked notes and merges it on the free one', async () => {
    await invokeHandler(TagsChannels.invoke.MERGE_TAG, { source: 'old', target: 'keep' })

    expect(getNoteTags(index.db, 'note-free')).toEqual(['keep'])
    expect(rows('note-locked')).toEqual(lockedRows)
    expect(rows('note-own-lock')).toEqual(lockedRows)
  })
})
