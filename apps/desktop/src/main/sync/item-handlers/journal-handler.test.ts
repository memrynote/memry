import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import { noteMetadata } from '@memry/db-schema/data-schema'
import { asSyncDb, createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { JournalChannels } from '@memry/contracts/ipc-channels'
import { SyncQueueManager } from '../queue'
import { journalHandler } from './journal-handler'
import type { ApplyContext, DrizzleDb } from './types'

const {
  journalFilePath,
  mockGetNoteMetadataById,
  mockUpdateNoteMetadata,
  mockSaveCanonicalNote,
  mockWriteJournalEntryWithContent,
  mockDeleteJournalEntryFile,
  mockSyncNoteToCache,
  mockDeleteNoteFromCache,
  mockFlushProjectionEvents,
  loggerMock
} = vi.hoisted(() => ({
  journalFilePath: '/tmp/memry-journal-handler-test.md',
  mockGetNoteMetadataById: vi.fn(),
  mockUpdateNoteMetadata: vi.fn(),
  mockSaveCanonicalNote: vi.fn(),
  mockWriteJournalEntryWithContent: vi.fn(),
  mockDeleteJournalEntryFile: vi.fn(),
  mockSyncNoteToCache: vi.fn(),
  mockDeleteNoteFromCache: vi.fn(),
  mockFlushProjectionEvents: vi.fn(),
  loggerMock: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  }
}))

vi.mock('../../database/client', () => ({
  getIndexDatabase: vi.fn(() => ({ index: true }))
}))

vi.mock('@memry/storage-data', () => ({
  getNoteMetadataById: (...args: unknown[]) => mockGetNoteMetadataById(...args),
  updateNoteMetadata: (...args: unknown[]) => mockUpdateNoteMetadata(...args)
}))

vi.mock('@memry/domain-notes', () => ({
  saveCanonicalNote: (...args: unknown[]) => mockSaveCanonicalNote(...args)
}))

vi.mock('../../vault/journal', () => ({
  deleteJournalEntryFile: (...args: unknown[]) => mockDeleteJournalEntryFile(...args),
  getJournalPath: vi.fn(() => journalFilePath),
  getJournalRelativePath: vi.fn((date: string) => `journals/${date}.md`),
  parseJournalEntry: vi.fn((_raw: string, date: string) => ({
    content: 'parsed content',
    frontmatter: {
      tags: ['parsed'],
      properties: { Mood: 'focused' }
    },
    date
  })),
  writeJournalEntryWithContent: (...args: unknown[]) => mockWriteJournalEntryWithContent(...args)
}))

vi.mock('../../vault/note-sync', () => ({
  syncNoteToCache: (...args: unknown[]) => mockSyncNoteToCache(...args),
  deleteNoteFromCache: (...args: unknown[]) => mockDeleteNoteFromCache(...args)
}))

vi.mock('../../projections', () => ({
  flushProjectionEvents: (...args: unknown[]) => mockFlushProjectionEvents(...args)
}))

vi.mock('../../lib/logger', () => ({
  createLogger: () => loggerMock
}))

function makeCtx(db: DrizzleDb = {} as DrizzleDb): ApplyContext {
  return {
    db,
    emit: vi.fn()
  }
}

async function flushPromises(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('journalHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDeleteJournalEntryFile.mockResolvedValue(undefined)
    mockWriteJournalEntryWithContent.mockResolvedValue({
      entry: {
        date: '2026-05-10',
        content: 'remote content',
        createdAt: '2026-05-10T09:00:00.000Z',
        modifiedAt: '2026-05-10T10:00:00.000Z'
      },
      fileContent: '---\n---\nremote content',
      frontmatter: { tags: ['remote'] }
    })
    fs.writeFileSync(journalFilePath, 'raw journal')
  })

  afterEach(() => {
    fs.rmSync(journalFilePath, { force: true })
  })

  it('creates new synced journal entries and writes cache/projection side effects', async () => {
    mockGetNoteMetadataById.mockReturnValue(undefined)
    const ctx = makeCtx()

    expect(
      journalHandler.applyUpsert(
        ctx,
        'journal-1',
        {
          date: '2026-05-10',
          content: 'remote content',
          tags: ['remote'],
          properties: { Mood: 'focused' }
        },
        { 'device-a': 1 }
      )
    ).toBe('applied')
    await flushPromises()

    expect(mockWriteJournalEntryWithContent).toHaveBeenCalledWith(
      '2026-05-10',
      'remote content',
      ['remote'],
      null,
      { Mood: 'focused' }
    )
    expect(mockSaveCanonicalNote).toHaveBeenCalledWith(
      ctx.db,
      expect.objectContaining({
        id: 'journal-1',
        path: 'journals/2026-05-10.md',
        title: '2026-05-10',
        journalDate: '2026-05-10',
        clock: { 'device-a': 1 },
        properties: { Mood: 'focused' }
      })
    )
    expect(mockSyncNoteToCache).toHaveBeenCalledWith(
      { index: true },
      expect.objectContaining({
        id: 'journal-1',
        path: 'journals/2026-05-10.md',
        parsedContent: 'remote content'
      }),
      { isNew: true }
    )
    expect(mockFlushProjectionEvents).toHaveBeenCalled()
    expect(ctx.emit).toHaveBeenCalledWith(JournalChannels.events.ENTRY_CREATED, {
      date: '2026-05-10',
      source: 'sync'
    })
  })

  it('skips an upsert with no date instead of writing an undefined day', async () => {
    // `date` is optional in the schema only so delete tombstones can omit it.
    // A create/update without one has no day to write to, so the handler has to
    // reject it where the required field used to.
    mockGetNoteMetadataById.mockReturnValue(undefined)
    const ctx = makeCtx()

    expect(
      journalHandler.applyUpsert(ctx, 'journal-1', { content: 'orphan' }, { 'device-a': 1 })
    ).toBe('skipped')
    await flushPromises()

    expect(mockWriteJournalEntryWithContent).not.toHaveBeenCalled()
    expect(mockSaveCanonicalNote).not.toHaveBeenCalled()
    expect(ctx.emit).not.toHaveBeenCalled()
    expect(loggerMock.warn).toHaveBeenCalledWith('Skipping remote journal upsert with no date', {
      itemId: 'journal-1'
    })
  })

  it('applies a delete without reading the tombstone body at all', async () => {
    // The receiver-side half of the compat argument for dropping `date`:
    // applyDelete takes only (ctx, itemId, clock) — there is no parameter that
    // could carry the payload — and it resolves the day from the local row.
    // Every shipped build behaves this way, so a tombstone with no date is
    // indistinguishable from one with a date on any receiver.
    mockGetNoteMetadataById.mockReturnValue({
      id: 'journal-1',
      journalDate: '2026-05-10',
      clock: { 'device-a': 1 }
    })
    const ctx = makeCtx()

    expect(journalHandler.applyDelete(ctx, 'journal-1', { 'device-a': 2 })).toBe('applied')

    expect(mockDeleteJournalEntryFile).toHaveBeenCalledWith('2026-05-10')
    expect(ctx.emit).toHaveBeenCalledWith(JournalChannels.events.ENTRY_DELETED, {
      date: '2026-05-10',
      source: 'sync'
    })
  })

  it('skips stale updates and applies concurrent updates as conflicts', async () => {
    const ctx = makeCtx()
    mockGetNoteMetadataById.mockReturnValueOnce({
      id: 'journal-1',
      journalDate: '2026-05-10',
      clock: { 'device-a': 3 }
    })

    expect(
      journalHandler.applyUpsert(
        ctx,
        'journal-1',
        { date: '2026-05-10', content: 'stale' },
        { 'device-a': 2 }
      )
    ).toBe('skipped')
    expect(mockWriteJournalEntryWithContent).not.toHaveBeenCalled()

    mockGetNoteMetadataById.mockReturnValueOnce({
      id: 'journal-1',
      journalDate: '2026-05-10',
      clock: { 'device-a': 3 }
    })
    expect(
      journalHandler.applyUpsert(
        ctx,
        'journal-1',
        { date: '2026-05-10', content: 'remote merge' },
        { 'device-b': 1 }
      )
    ).toBe('conflict')
    expect(ctx.emit).toHaveBeenCalledWith(JournalChannels.events.ENTRY_UPDATED, {
      date: '2026-05-10',
      source: 'sync'
    })

    await flushPromises()
    expect(mockSaveCanonicalNote).toHaveBeenCalledWith(
      ctx.db,
      expect.objectContaining({
        clock: { 'device-a': 3, 'device-b': 1 },
        modifiedAt: '2026-05-10T10:00:00.000Z'
      })
    )
  })

  it('deletes synced entries, guards stale deletes, and fetches only journal notes', () => {
    const ctx = makeCtx()

    mockGetNoteMetadataById.mockReturnValueOnce(undefined)
    expect(journalHandler.applyDelete(ctx, 'missing')).toBe('skipped')

    mockGetNoteMetadataById.mockReturnValueOnce({
      id: 'journal-1',
      journalDate: '2026-05-10',
      clock: { 'device-a': 3 }
    })
    expect(journalHandler.applyDelete(ctx, 'journal-1', { 'device-b': 1 })).toBe('skipped')

    mockGetNoteMetadataById.mockReturnValueOnce({
      id: 'journal-1',
      journalDate: '2026-05-10',
      clock: { 'device-a': 1 }
    })
    expect(journalHandler.applyDelete(ctx, 'journal-1', { 'device-a': 2 })).toBe('applied')
    expect(mockDeleteJournalEntryFile).toHaveBeenCalledWith('2026-05-10')
    expect(mockDeleteNoteFromCache).toHaveBeenCalledWith({ index: true }, 'journal-1')
    expect(mockFlushProjectionEvents).toHaveBeenCalled()
    expect(ctx.emit).toHaveBeenCalledWith(JournalChannels.events.ENTRY_DELETED, {
      date: '2026-05-10',
      source: 'sync'
    })

    mockGetNoteMetadataById.mockReturnValueOnce({ id: 'note-1', journalDate: null })
    expect(journalHandler.fetchLocal(ctx.db, 'note-1')).toBeUndefined()
    mockGetNoteMetadataById.mockReturnValueOnce({ id: 'journal-1', journalDate: '2026-05-10' })
    expect(journalHandler.fetchLocal(ctx.db, 'journal-1')).toMatchObject({
      id: 'journal-1',
      journalDate: '2026-05-10'
    })
  })

  it('builds push payloads and seeds unclocked journal entries', () => {
    mockGetNoteMetadataById.mockReturnValueOnce(undefined)
    expect(journalHandler.buildPushPayload({} as DrizzleDb, 'missing', 'device-a', 'create')).toBe(
      null
    )

    mockGetNoteMetadataById.mockReturnValueOnce({
      id: 'journal-1',
      journalDate: '2026-05-10',
      clock: { 'device-a': 1 },
      createdAt: '2026-05-10T09:00:00.000Z',
      modifiedAt: '2026-05-10T10:00:00.000Z'
    })
    expect(
      JSON.parse(journalHandler.buildPushPayload({} as DrizzleDb, 'journal-1', 'd', 'create') ?? '')
    ).toMatchObject({
      date: '2026-05-10',
      content: 'parsed content',
      tags: ['parsed'],
      properties: { Mood: 'focused' },
      clock: { 'device-a': 1 }
    })

    mockGetNoteMetadataById.mockReturnValueOnce({
      id: 'journal-1',
      journalDate: '2026-05-10',
      clock: { 'device-a': 1 },
      createdAt: '2026-05-10T09:00:00.000Z',
      modifiedAt: '2026-05-10T10:00:00.000Z'
    })
    fs.rmSync(journalFilePath, { force: true })
    expect(
      JSON.parse(journalHandler.buildPushPayload({} as DrizzleDb, 'journal-1', 'd', 'update') ?? '')
    ).toMatchObject({
      date: '2026-05-10',
      content: null,
      tags: [],
      properties: null
    })
    expect(loggerMock.warn).toHaveBeenCalled()

    const testDb = createTestDataDb()
    try {
      testDb.db
        .insert(noteMetadata)
        .values([
          {
            id: 'journal-local',
            path: 'journals/2026-05-11.md',
            title: '2026-05-11',
            journalDate: '2026-05-11',
            createdAt: '2026-05-11T09:00:00.000Z',
            modifiedAt: '2026-05-11T10:00:00.000Z'
          },
          {
            id: 'plain-note',
            path: 'notes/plain.md',
            title: 'Plain',
            journalDate: null,
            createdAt: '2026-05-11T09:00:00.000Z',
            modifiedAt: '2026-05-11T10:00:00.000Z'
          }
        ])
        .run()

      const queue = new SyncQueueManager(asSyncDb(testDb.db))
      expect(
        journalHandler.seedUnclocked(testDb.db as unknown as DrizzleDb, 'device-a', queue)
      ).toBe(1)
      const [queued] = queue.dequeue(1)
      expect(mockUpdateNoteMetadata).toHaveBeenCalledWith(testDb.db, 'journal-local', {
        clock: { 'device-a': 1 }
      })
      expect(queued).toMatchObject({
        type: 'journal',
        itemId: 'journal-local',
        operation: 'create'
      })
      expect(JSON.parse(queued.payload)).toMatchObject({
        date: '2026-05-11',
        clock: { 'device-a': 1 }
      })
    } finally {
      testDb.close()
    }
  })
})
