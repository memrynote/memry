import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mocks = vi.hoisted(() => {
  return {
    db: {} as object,
    isDatabaseInitialized: vi.fn(() => true),
    getDatabase: vi.fn(() => null as unknown),
    vaultPath: { path: '/vault' } as unknown,
    getNoteAttachmentsDir: vi.fn((..._args: unknown[]) => '/vault/attachments/note-x'),
    toAbsolutePath: vi.fn((p: string) => `/vault/${p}`),
    getNoteMetadataById: vi.fn(),
    redrivableRows: [] as Array<{
      ownerId: string
      attachmentId: string
      reason: 'missing' | 'transient'
      attempts: number
    }>,
    shouldAttemptDownload: vi.fn((..._args: unknown[]) => true),
    markDownloadRequested: vi.fn(),
    releaseDownloadAttempt: vi.fn(),
    autoDownloadEnabled: true,
    emitted: [] as Array<Record<string, unknown>>,
    delivered: true
  }
})

vi.mock('../lib/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  })
}))

vi.mock('../database', () => ({
  getDatabase: () => mocks.getDatabase(),
  isDatabaseInitialized: () => mocks.isDatabaseInitialized()
}))

vi.mock('../vault/index', () => ({
  getStatus: () => mocks.vaultPath
}))

vi.mock('../vault/attachments', () => ({
  getNoteAttachmentsDir: (...args: unknown[]) => mocks.getNoteAttachmentsDir(...args)
}))

vi.mock('../vault/notes', () => ({
  toAbsolutePath: (p: string) => mocks.toAbsolutePath(p)
}))

vi.mock('@memry/storage-data', () => ({
  getNoteMetadataById: (...args: unknown[]) => mocks.getNoteMetadataById(...args)
}))

vi.mock('@memry/sync-client/attachment-events', () => ({
  attachmentEvents: {
    emitDownloadNeeded: (event: Record<string, unknown>) => {
      mocks.emitted.push(event)
      return mocks.delivered
    }
  }
}))

vi.mock('@memry/sync-client/attachment-download-state', () => ({
  listRedrivableDownloadFailures: () => mocks.redrivableRows,
  shouldAttemptDownload: (...args: unknown[]) => mocks.shouldAttemptDownload(...args),
  markDownloadRequested: (...args: unknown[]) => mocks.markDownloadRequested(...args),
  releaseDownloadAttempt: (...args: unknown[]) => mocks.releaseDownloadAttempt(...args)
}))

vi.mock('./attachment-download-settings', () => ({
  isAttachmentAutoDownloadEnabled: () => mocks.autoDownloadEnabled
}))

import {
  redriveAttachmentDownloads,
  startAttachmentDownloadRedriver,
  stopAttachmentDownloadRedriver
} from './attachment-download-redriver'

describe('attachment download re-driver', () => {
  beforeEach(() => {
    mocks.isDatabaseInitialized.mockReturnValue(true)
    mocks.autoDownloadEnabled = true
    mocks.delivered = true
    mocks.emitted.length = 0
    mocks.redrivableRows = []
    mocks.shouldAttemptDownload.mockReset().mockReturnValue(true)
    mocks.markDownloadRequested.mockReset()
    mocks.releaseDownloadAttempt.mockReset()
    mocks.getNoteMetadataById.mockReset()
    mocks.getNoteMetadataById.mockImplementation((_db: unknown, id: string) => ({
      id,
      path: `${id}.md`,
      modifiedAt: '2026-01-02T00:00:00.000Z',
      // Default: an embedded-attachment note referencing every fixture id;
      // individual tests override this for binary notes / dropped references.
      attachmentReferences: ['att-a', 'att-b', 'att-embedded'],
      attachmentId: undefined
    }))
    stopAttachmentDownloadRedriver()
  })

  afterEach(() => {
    stopAttachmentDownloadRedriver()
  })

  it('feeds due failures back through the download-needed event with the right target', async () => {
    mocks.redrivableRows = [
      { ownerId: 'note-1', attachmentId: 'att-embedded', reason: 'transient', attempts: 2 },
      { ownerId: 'note-2', attachmentId: 'att-binary', reason: 'transient', attempts: 1 }
    ]
    mocks.getNoteMetadataById.mockImplementation((_db: unknown, id: string) =>
      id === 'note-2'
        ? {
            id,
            path: 'bin.md',
            modifiedAt: '2026-01-05T00:00:00.000Z',
            attachmentReferences: [],
            attachmentId: 'att-binary',
            fileSize: 4096
          }
        : {
            id,
            path: `${id}.md`,
            modifiedAt: '2026-01-02T00:00:00.000Z',
            attachmentReferences: ['att-embedded'],
            attachmentId: undefined
          }
    )

    const summary = await redriveAttachmentDownloads()

    expect(summary).toEqual({ requested: 2, skipped: 0 })
    // Embedded attachment materializes into the note's attachments dir...
    expect(mocks.emitted[0]).toMatchObject({
      noteId: 'note-1',
      attachmentId: 'att-embedded',
      diskPath: '/vault/attachments/note-x',
      intoDir: true,
      recencyHint: Date.parse('2026-01-02T00:00:00.000Z')
    })
    // ...a binary note IS the file, and its size feeds the small-first order.
    expect(mocks.emitted[1]).toMatchObject({
      noteId: 'note-2',
      attachmentId: 'att-binary',
      diskPath: '/vault/bin.md',
      sizeHint: 4096
    })
    // Claim discipline mirrors the pull path.
    expect(mocks.markDownloadRequested).toHaveBeenCalledTimes(2)
  })

  it('skips rows whose note vanished or no longer references the attachment', async () => {
    mocks.redrivableRows = [
      { ownerId: 'note-gone', attachmentId: 'att-a', reason: 'transient', attempts: 1 },
      { ownerId: 'note-x', attachmentId: 'att-dropped', reason: 'transient', attempts: 1 }
    ]
    mocks.getNoteMetadataById.mockImplementation((_db: unknown, id: string) =>
      id === 'note-gone'
        ? undefined
        : {
            id,
            path: `${id}.md`,
            modifiedAt: '2026-01-02T00:00:00.000Z',
            attachmentReferences: ['att-embedded'],
            attachmentId: undefined
          }
    )

    const summary = await redriveAttachmentDownloads()

    expect(summary).toEqual({ requested: 0, skipped: 2 })
    expect(mocks.emitted).toHaveLength(0)
    expect(mocks.markDownloadRequested).not.toHaveBeenCalled()
  })

  it('does not double-request items that are in flight or otherwise guarded', async () => {
    mocks.redrivableRows = [
      { ownerId: 'note-1', attachmentId: 'att-busy', reason: 'transient', attempts: 1 }
    ]
    mocks.shouldAttemptDownload.mockReturnValue(false)

    const summary = await redriveAttachmentDownloads()

    expect(summary).toEqual({ requested: 0, skipped: 1 })
    expect(mocks.emitted).toHaveLength(0)
    expect(mocks.markDownloadRequested).not.toHaveBeenCalled()
  })

  it('is a no-op when auto-download is off, the DB is down, or no vault is open', async () => {
    mocks.redrivableRows = [
      { ownerId: 'note-1', attachmentId: 'att-a', reason: 'transient', attempts: 1 }
    ]

    mocks.autoDownloadEnabled = false
    expect(await redriveAttachmentDownloads()).toEqual({ requested: 0, skipped: 0 })

    mocks.autoDownloadEnabled = true
    mocks.isDatabaseInitialized.mockReturnValue(false)
    expect(await redriveAttachmentDownloads()).toEqual({ requested: 0, skipped: 0 })

    mocks.isDatabaseInitialized.mockReturnValue(true)
    mocks.vaultPath = { path: null } as unknown
    expect(await redriveAttachmentDownloads()).toEqual({ requested: 0, skipped: 0 })

    expect(mocks.emitted).toHaveLength(0)
    mocks.vaultPath = { path: '/vault' } as unknown
  })

  it('releases the claim and stops when no listener is registered', async () => {
    mocks.delivered = false
    mocks.redrivableRows = [
      { ownerId: 'note-1', attachmentId: 'att-a', reason: 'transient', attempts: 1 },
      { ownerId: 'note-2', attachmentId: 'att-b', reason: 'transient', attempts: 1 }
    ]

    const summary = await redriveAttachmentDownloads()

    expect(summary).toEqual({ requested: 0, skipped: 0 })
    expect(mocks.releaseDownloadAttempt).toHaveBeenCalledWith('note-1', 'att-a')
    // The second row is deliberately not attempted — the runtime is going away.
    expect(mocks.emitted).toHaveLength(1)
  })

  describe('interval lifecycle', () => {
    it('re-drives on the interval until stopped', async () => {
      vi.useFakeTimers()
      mocks.redrivableRows = [
        { ownerId: 'note-1', attachmentId: 'att-a', reason: 'transient', attempts: 1 }
      ]

      startAttachmentDownloadRedriver()

      // Nothing fires before the first tick.
      await vi.advanceTimersByTimeAsync(15 * 60 * 1000 - 1)
      expect(mocks.emitted).toHaveLength(0)

      await vi.advanceTimersByTimeAsync(1)
      expect(mocks.emitted).toHaveLength(1)

      await vi.advanceTimersByTimeAsync(15 * 60 * 1000)
      expect(mocks.emitted).toHaveLength(2)

      stopAttachmentDownloadRedriver()
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
      expect(mocks.emitted).toHaveLength(2)
    })

    it('starting twice does not stack intervals', async () => {
      vi.useFakeTimers()
      mocks.redrivableRows = [
        { ownerId: 'note-1', attachmentId: 'att-a', reason: 'transient', attempts: 1 }
      ]

      startAttachmentDownloadRedriver()
      startAttachmentDownloadRedriver()

      await vi.advanceTimersByTimeAsync(15 * 60 * 1000)
      expect(mocks.emitted).toHaveLength(1)

      stopAttachmentDownloadRedriver()
    })
  })
})
