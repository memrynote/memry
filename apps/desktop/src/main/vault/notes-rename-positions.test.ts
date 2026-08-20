/**
 * Sidebar order across a rename and a move — #1646.
 *
 * Position rows are keyed by path, and both operations rewrite the path. The
 * rename case is the one users meet constantly: every new note opens with its
 * rename input focused, so a note that loses its row on rename is a note that
 * jumps to the bottom seconds after it was placed.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'
import type { DataDb } from '@main/database/types'
import {
  getAllNotePositions,
  getNotePosition,
  getNotesInFolder,
  reorderNotesInFolder
} from '@main/database/queries/note-positions'

const mocks = vi.hoisted(() => ({
  getDatabase: vi.fn(),
  getNoteById: vi.fn(),
  rename: vi.fn()
}))

vi.mock('fs/promises', () => ({
  default: { rename: mocks.rename },
  rename: mocks.rename
}))

vi.mock('./notes-crud', () => ({ getNoteById: mocks.getNoteById }))
vi.mock('@main/database/queries/notes', () => ({ getNoteCacheById: vi.fn(() => undefined) }))
vi.mock('../database', () => ({
  getDatabase: mocks.getDatabase,
  getIndexDatabase: vi.fn(() => ({}))
}))
vi.mock('./file-ops', () => ({
  ensureDirectory: vi.fn(),
  sanitizeFilename: (name: string) => name,
  generateUniquePath: (candidate: string) => candidate,
  safeRead: vi.fn(async () => ''),
  atomicWrite: vi.fn()
}))
vi.mock('./notes-io', () => ({
  emitNoteEvent: vi.fn(),
  getVaultRoot: vi.fn(() => '/vault'),
  toAbsolutePath: (relative: string) => `/vault/${relative}`,
  toRelativePath: (absolute: string) => absolute.replace('/vault/', '')
}))
vi.mock('./note-sync', () => ({ syncNoteToCache: vi.fn(), syncFileToCache: vi.fn() }))
vi.mock('./frontmatter', () => ({
  parseNote: vi.fn(() => ({ frontmatter: {}, content: '' }))
}))
vi.mock('./rewrite-note-refs', () => ({ rewriteNoteRefsForMove: vi.fn(() => null) }))
vi.mock('../sync/crdt-feed', () => ({ replaceNoteBodyInCrdt: vi.fn() }))
vi.mock('../sync/crdt-writeback', () => ({ markWritebackIgnored: vi.fn() }))
vi.mock('@memry/storage-data', () => ({ updateNoteMetadata: vi.fn() }))

import { moveNote, renameNote } from './notes-rename'

const noteAt = (path: string) => ({
  id: 'note-1',
  path,
  title: path.split('/').pop()!.replace(/\.md$/, ''),
  content: '',
  frontmatter: {},
  created: new Date('2026-08-20T00:00:00.000Z'),
  modified: new Date('2026-08-20T00:00:00.000Z'),
  tags: [],
  aliases: [],
  wordCount: 0,
  properties: {},
  emoji: null
})

describe('sidebar order across rename and move (#1646)', () => {
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

  it('keeps a renamed note in its slot', async () => {
    // #given a new note holding the top of a hand-ordered folder
    reorderNotesInFolder(db, 'Work', ['Work/Untitled.md', 'Work/a.md', 'Work/b.md'])
    mocks.getNoteById.mockResolvedValue(noteAt('Work/Untitled.md'))

    // #when the rename that opened with it is committed
    await renameNote('note-1', 'Q3 plan')

    // #then the row followed the path and the row-less fallback never applies
    expect(getNotesInFolder(db, 'Work').map((n) => n.path)).toEqual([
      'Work/Q3 plan.md',
      'Work/a.md',
      'Work/b.md'
    ])
  })

  it('invents no position when renaming inside a folder nobody ordered', async () => {
    mocks.getNoteById.mockResolvedValue(noteAt('Work/Untitled.md'))

    await renameNote('note-1', 'Q3 plan')

    expect(getAllNotePositions(db)).toEqual([])
  })

  it('moves a note to the top of its new folder and abandons the old row', async () => {
    reorderNotesInFolder(db, 'Work', ['Work/a.md'])
    reorderNotesInFolder(db, 'Archive', ['Archive/x.md', 'Archive/y.md'])
    mocks.getNoteById.mockResolvedValue(noteAt('Work/a.md'))

    await moveNote('note-1', 'Archive')

    expect(getNotePosition(db, 'Work/a.md')).toBeUndefined()
    expect(getNotesInFolder(db, 'Archive').map((n) => n.path)).toEqual([
      'Archive/a.md',
      'Archive/x.md',
      'Archive/y.md'
    ])
  })
})
