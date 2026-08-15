import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { MarkdownSizeClass, LargeFileReason } from '@memry/shared/markdown-class'
import type { NoteSizeClass, NoteLargeFileReason } from '@memry/contracts/notes-api'

const mocks = vi.hoisted(() => ({
  getNoteCacheById: vi.fn(),
  safeRead: vi.fn(),
  stat: vi.fn()
}))

vi.mock('fs/promises', () => ({
  default: { stat: mocks.stat },
  stat: mocks.stat
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
  safeRead: mocks.safeRead,
  deleteFile: vi.fn(),
  ensureDirectory: vi.fn(),
  listDirectories: vi.fn(),
  generateNotePath: vi.fn(),
  generateUniquePath: vi.fn()
}))

vi.mock('./notes-io', () => ({
  emitNoteEvent: vi.fn(),
  getDefaultNoteDir: vi.fn(() => '/vault/notes'),
  getVaultRoot: vi.fn(() => '/vault'),
  toAbsolutePath: (relative: string) => `/vault/${relative}`,
  toRelativePath: (absolute: string) => absolute.replace('/vault/', '')
}))

vi.mock('../database', () => ({ getDatabase: vi.fn(), getIndexDatabase: vi.fn(() => ({})) }))
vi.mock('../sync/crdt-writeback', () => ({ hasPendingWriteback: vi.fn(() => false) }))
vi.mock('../tasks/reconcile-markdown-tasks', () => ({
  reconcileTaskCheckboxesFromMarkdown: vi.fn(async () => undefined)
}))
vi.mock('./note-sync', () => ({ syncNoteToCache: vi.fn(), deleteNoteFromCache: vi.fn() }))
vi.mock('./notes-versions', () => ({ maybeCreateSignificantSnapshot: vi.fn() }))
vi.mock('./notes-queries', () => ({ noteToListItem: vi.fn() }))
vi.mock('./folders', () => ({ readFolderConfig: vi.fn() }))
vi.mock('./index', () => ({ getStatus: vi.fn(), getConfig: vi.fn(() => ({})) }))
vi.mock('../telemetry/diagnostics', () => ({ trackMainLog: vi.fn() }))
vi.mock('../notes/note-date-reminders', () => ({
  syncNoteDateReminders: vi.fn(),
  clearNoteDateReminders: vi.fn()
}))
vi.mock('../sync/local-mutations', () => ({
  enqueueLocalSyncCreate: vi.fn(),
  enqueueLocalSyncDelete: vi.fn(),
  enqueueLocalSyncUpdate: vi.fn()
}))

import { getNoteById } from './notes-crud'

const cachedRow = {
  id: 'note-1',
  path: 'notes/dump.md',
  title: 'dump',
  createdAt: '2026-08-01T00:00:00.000Z',
  modifiedAt: '2026-08-01T00:00:00.000Z',
  wordCount: 0,
  emoji: null,
  fileType: 'markdown'
}

describe('getNoteById size classification', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getNoteCacheById.mockReturnValue(cachedRow)
  })

  it('never reads a file over the byte ceiling', async () => {
    // #given a 250 MB paste. V8 caps a single string at ~512 MB and even below
    // that the read alone is a main-process allocation and GC pause.
    mocks.stat.mockResolvedValue({ size: 250 * 1024 * 1024 })
    mocks.safeRead.mockImplementation(() => {
      throw new Error('safeRead must not be called for an over-ceiling file')
    })

    // #when
    const note = await getNoteById('note-1')

    // #then
    expect(mocks.safeRead).not.toHaveBeenCalled()
    expect(note?.sizeClass).toBe('large-file')
    expect(note?.largeFile).toEqual({
      reason: 'file-bytes',
      fileBytes: 250 * 1024 * 1024,
      largestBlockBytes: null
    })
    expect(note?.content).toBe('')
    expect(note?.contentOmitted).toBe(true)
  })

  it('reads a sub-ceiling file but still refuses it when one block is enormous', async () => {
    // #given a 600 KB log dump: cheap to read, ruinous to parse
    const dump = Array.from({ length: 20_000 }, (_, i) => `2026-08-15 line ${i} payload`).join('\n')
    mocks.stat.mockResolvedValue({ size: dump.length })
    mocks.safeRead.mockResolvedValue(dump)

    // #when
    const note = await getNoteById('note-1')

    // #then — the block bound is the one that catches this shape
    expect(mocks.safeRead).toHaveBeenCalled()
    expect(note?.sizeClass).toBe('large-file')
    expect(note?.largeFile?.reason).toBe('block-bytes')
    expect(note?.content).toBe('')
  })

  it('leaves an ordinary note untouched', async () => {
    // #given the shape every existing vault produces
    const body = 'Hello\n\nWorld'
    mocks.stat.mockResolvedValue({ size: body.length })
    mocks.safeRead.mockResolvedValue(body)

    // #when
    const note = await getNoteById('note-1')

    // #then — no new fields leak onto note-class notes
    expect(note?.sizeClass).toBeUndefined()
    expect(note?.largeFile).toBeUndefined()
    expect(note?.contentOmitted).toBeUndefined()
    expect(note?.content).toBe(body)
  })
})

// ---------------------------------------------------------------------------
// Contract parity
// ---------------------------------------------------------------------------

/**
 * `packages/contracts` deliberately does not depend on `packages/shared`, so the
 * size-class unions are declared twice. Desktop depends on both, so this is
 * where they get pinned together — a drift here is a compile error, not a
 * runtime surprise at the IPC boundary.
 */
type Equal<A, B> =
  (<G>() => G extends A ? 1 : 2) extends <G>() => G extends B ? 1 : 2 ? true : false
// These only compile while the two declarations agree: if either union drifts,
// `Equal` resolves to `false` and the initializer stops typechecking.
const sizeClassParity: Equal<MarkdownSizeClass, NoteSizeClass> = true
const reasonParity: Equal<LargeFileReason, NoteLargeFileReason> = true

describe('size-class contract parity', () => {
  it('keeps the shared classifier and the IPC contract on the same unions', () => {
    // The real gate is the two consts above — a drift is a compile error. This
    // keeps the file honest about why it exists and reports in the suite.
    expect(sizeClassParity).toBe(true)
    expect(reasonParity).toBe(true)

    const shared: MarkdownSizeClass[] = ['note', 'large-file']
    const contract: NoteSizeClass[] = shared
    expect(contract).toEqual(['note', 'large-file'])
  })
})
