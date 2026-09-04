/**
 * Sidebar order across a note's lifecycle — #1646.
 *
 * The vault is mocked away; the data DB is real. What is under test is the
 * wiring: that `createNote`, `deleteNote` and the folder calls reach the
 * position table at all. The policy those calls carry out is covered
 * exhaustively in `database/queries/note-positions.test.ts`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'
import type { DataDb } from '@main/database/types'
import {
  getAllNotePositions,
  getNotesInFolder,
  reorderNotesInFolder,
  setNotePosition
} from '@main/database/queries/note-positions'

const mocks = vi.hoisted(() => ({
  getDatabase: vi.fn(),
  getNoteCacheById: vi.fn(),
  rm: vi.fn(),
  rename: vi.fn()
}))

vi.mock('fs/promises', () => ({
  default: { rm: mocks.rm, rename: mocks.rename },
  rm: mocks.rm,
  rename: mocks.rename
}))

vi.mock('@main/database/queries/notes', () => ({
  getNoteCacheById: mocks.getNoteCacheById,
  getNoteCacheByPath: vi.fn(),
  getNoteTags: vi.fn(() => []),
  ensureTagDefinitions: vi.fn(),
  getNotePropertiesAsRecord: vi.fn(() => ({})),
  resolveNoteByTitle: vi.fn()
}))

vi.mock('./file-ops', () => ({
  atomicWrite: vi.fn(),
  safeRead: vi.fn(),
  deleteFile: vi.fn(),
  ensureDirectory: vi.fn(),
  listDirectories: vi.fn(() => []),
  generateNotePath: (dir: string, title: string, folder?: string) =>
    folder ? `${dir}/${folder}/${title}.md` : `${dir}/${title}.md`,
  generateUniquePath: (candidate: string) => candidate,
  withTransientFsRetry: <T>(operation: () => Promise<T>) => operation()
}))

vi.mock('./notes-io', () => ({
  emitNoteEvent: vi.fn(),
  getDefaultNoteDir: vi.fn(() => '/vault'),
  getVaultRoot: vi.fn(() => '/vault'),
  toAbsolutePath: (relative: string) => `/vault/${relative}`,
  toRelativePath: (absolute: string) => absolute.replace('/vault/', '')
}))

vi.mock('../database', () => ({
  getDatabase: mocks.getDatabase,
  getIndexDatabase: vi.fn(() => ({}))
}))
vi.mock('./note-sync', () => ({
  syncNoteToCache: vi.fn(() => ({ wordCount: 0 })),
  deleteNoteFromCache: vi.fn()
}))
vi.mock('./notes-queries', () => ({ noteToListItem: vi.fn(() => ({})) }))
vi.mock('./notes-versions', () => ({ maybeCreateSignificantSnapshot: vi.fn() }))
vi.mock('./folders', () => ({ readFolderConfig: vi.fn(), getFolderTemplate: vi.fn(() => null) }))
vi.mock('./index', () => ({ getStatus: vi.fn(), getConfig: vi.fn(() => ({})) }))
vi.mock('./templates', () => ({ getTemplate: vi.fn(() => null), applyTemplate: vi.fn() }))
vi.mock('../telemetry/diagnostics', () => ({ trackMainLog: vi.fn() }))
vi.mock('../sync/crdt-writeback', () => ({ hasPendingWriteback: vi.fn(() => false) }))
vi.mock('../tasks/reconcile-markdown-tasks', () => ({
  reconcileTaskCheckboxesFromMarkdown: vi.fn(async () => undefined)
}))
vi.mock('../notes/note-date-reminders', () => ({
  syncNoteDateReminders: vi.fn(),
  clearNoteDateReminders: vi.fn()
}))
vi.mock('../sync/local-mutations', () => ({
  enqueueLocalSyncCreate: vi.fn(),
  enqueueLocalSyncDelete: vi.fn(),
  enqueueLocalSyncUpdate: vi.fn()
}))

import { createFolder, createNote, deleteFolder, deleteNote, renameFolder } from './notes-crud'

describe('sidebar order across the note lifecycle (#1646)', () => {
  let testDb: TestDatabaseResult
  let db: DataDb

  beforeEach(() => {
    vi.clearAllMocks()
    testDb = createTestDataDb()
    db = testDb.db as unknown as DataDb
    mocks.getDatabase.mockReturnValue(db)
  })

  afterEach(() => {
    testDb.close()
  })

  it('creates a note above everything in a hand-ordered folder', async () => {
    // #given a folder the user dragged into order
    reorderNotesInFolder(db, 'Work', ['Work/a.md', 'Work/b.md'])

    // #when a note is created in it
    await createNote({ title: 'Untitled', folder: 'Work' })

    // #then it leads the folder rather than sinking below both
    expect(getNotesInFolder(db, 'Work').map((n) => n.path)).toEqual([
      'Work/Untitled.md',
      'Work/a.md',
      'Work/b.md'
    ])
  })

  it('leaves an untouched vault with no position rows at all', async () => {
    // #given a vault nobody has ever reordered
    // #when notes are created at the root and in a folder
    await createNote({ title: 'Untitled' })
    await createNote({ title: 'Second', folder: 'Work' })

    // #then nothing is written: implicit newest-first order still governs, and
    // freezing it here would be an upgrade that moves somebody's sidebar
    expect(getAllNotePositions(db)).toEqual([])
  })

  it('creates a folder above everything in a hand-ordered parent', async () => {
    reorderNotesInFolder(db, '', ['Alpha', 'Beta'])

    await createFolder('Untitled Folder')

    expect(getNotesInFolder(db, '').map((n) => n.path)).toEqual([
      'Untitled Folder',
      'Alpha',
      'Beta'
    ])
  })

  it('drops a deleted note row so the next note at that path cannot inherit it', async () => {
    reorderNotesInFolder(db, 'Work', ['Work/Untitled.md', 'Work/a.md'])
    mocks.getNoteCacheById.mockReturnValue({
      id: 'note-1',
      path: 'Work/Untitled.md',
      title: 'Untitled',
      fileType: 'markdown'
    })

    await deleteNote('note-1')

    expect(getAllNotePositions(db).map((r) => r.path)).toEqual(['Work/a.md'])
  })

  it('carries a renamed folder and its contents to the new path', async () => {
    setNotePosition(db, 'Work', '', 0)
    setNotePosition(db, 'Work/a.md', 'Work', 0)

    await renameFolder('Work', 'Projects')

    expect(
      getAllNotePositions(db)
        .map((r) => r.path)
        .sort()
    ).toEqual(['Projects', 'Projects/a.md'])
  })

  it('drops a deleted folder and everything under it', async () => {
    setNotePosition(db, 'Work', '', 0)
    setNotePosition(db, 'Work/a.md', 'Work', 0)
    setNotePosition(db, 'Other/a.md', 'Other', 0)

    await deleteFolder('Work')

    expect(getAllNotePositions(db).map((r) => r.path)).toEqual(['Other/a.md'])
  })
})
