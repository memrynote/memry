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
  type TestDatabaseResult
} from '@tests/utils/test-db'
import { getNoteTags, insertNoteCache, setNoteTags } from '@main/database/queries/notes'

const state = vi.hoisted(() => ({ data: null as unknown, index: null as unknown }))

const files = vi.hoisted(() => ({
  readFile: vi.fn(async () => '---\ntags: [old]\n---\nBody\n'),
  atomicWrite: vi.fn(async () => undefined)
}))

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

vi.mock('fs/promises', () => ({ readFile: files.readFile }))
vi.mock('../vault/notes', () => ({ toAbsolutePath: (p: string) => `/vault/${p}` }))
vi.mock('../vault/file-ops', () => ({ atomicWrite: files.atomicWrite }))
vi.mock('../telemetry/diagnostics', () => ({ trackMainError: vi.fn() }))
vi.mock('../telemetry/track', () => ({ trackMainEvent: vi.fn() }))
vi.mock('../tags/runtime-effects', () => ({
  syncMergedTagDefinitions: vi.fn(),
  syncTaggedNote: vi.fn(),
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
      setNoteTags(index.db, id, ['old', 'keep'])
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

  afterEach(() => {
    unregisterTagsHandlers()
    installVaultLockSource({ dataDb: () => null, notePathOf: () => null, noteIdAtPath: () => null })
    data.close()
    index.close()
  })

  it('rename keeps the old tag on locked notes and renames it on the free one', async () => {
    await invokeHandler(TagsChannels.invoke.RENAME_TAG, { oldName: 'old', newName: 'fresh' })

    expect(getNoteTags(index.db, 'note-free')).toEqual(['fresh', 'keep'])
    expect(getNoteTags(index.db, 'note-locked')).toEqual(['old', 'keep'])
    expect(getNoteTags(index.db, 'note-own-lock')).toEqual(['old', 'keep'])
    expect(files.atomicWrite).toHaveBeenCalledTimes(1)
  })

  it('delete keeps the tag on locked notes and removes it from the free one', async () => {
    await invokeHandler(TagsChannels.invoke.DELETE_TAG, 'old')

    expect(getNoteTags(index.db, 'note-free')).toEqual(['keep'])
    expect(getNoteTags(index.db, 'note-locked')).toEqual(['old', 'keep'])
    expect(getNoteTags(index.db, 'note-own-lock')).toEqual(['old', 'keep'])
  })

  it('merge keeps the source tag on locked notes and merges it on the free one', async () => {
    await invokeHandler(TagsChannels.invoke.MERGE_TAG, { source: 'old', target: 'keep' })

    expect(getNoteTags(index.db, 'note-free')).toEqual(['keep'])
    expect(getNoteTags(index.db, 'note-locked')).toEqual(['old', 'keep'])
    expect(getNoteTags(index.db, 'note-own-lock')).toEqual(['old', 'keep'])
  })
})
