import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { upsertNoteMetadata } from '@memry/storage-data'
import { attachmentEvents } from '@memry/sync-client/attachment-events'
import {
  markDownloadFailed,
  markDownloadSucceeded,
  resetAttachmentDownloadSession
} from '@memry/sync-client/attachment-download-state'
import { asClientDb, createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { restoreOverwrittenBinaryNotesWith } from './binary-note-restore'

vi.mock('../lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))
vi.mock('../database', () => ({ getDatabase: vi.fn(), isDatabaseInitialized: () => false }))
vi.mock('../store', () => ({ getCurrentVaultPath: () => null }))
const { trackMainLog } = vi.hoisted(() => ({ trackMainLog: vi.fn() }))
vi.mock('../telemetry/diagnostics', () => ({ trackMainLog }))

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52
])
const OTHER_PNG = Buffer.concat([PNG, Buffer.from([0x01, 0x02, 0x03])])
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46])
const WRITEBACK_MARKDOWN = '![Sunset](attachments/sunset.png)\n\nA caption in the doc.\n'

describe('restoreOverwrittenBinaryNotesWith (#5415)', () => {
  let vaultPath: string
  let testDb: TestDatabaseResult
  let serverBlobs: Map<string, Buffer>
  let online: boolean
  let seq = 0
  const downloader = ({
    noteId,
    attachmentId,
    diskPath,
    landed
  }: {
    noteId: string
    attachmentId: string
    diskPath: string
    landed?: () => void
  }): void => {
    // Mirrors the outcome bookkeeping of the real download-needed handler:
    // the blob lands by atomic rename, or the failure is persisted.
    const db = asClientDb(testDb.db)
    if (!online) {
      markDownloadFailed(db, noteId, attachmentId, new Error('fetch failed: offline'))
      return
    }
    const tmp = `${diskPath}.part`
    fs.writeFileSync(tmp, serverBlobs.get(attachmentId)!)
    fs.renameSync(tmp, diskPath)
    markDownloadSucceeded(db, noteId, attachmentId)
    landed?.()
  }

  function seedBinaryNote(relPath: string, onDisk: Buffer | string, blob = PNG) {
    const id = `note-${++seq}`
    const attachmentId = `att-${seq}`
    serverBlobs.set(attachmentId, blob)
    fs.writeFileSync(path.join(vaultPath, relPath), onDisk)
    upsertNoteMetadata(asClientDb(testDb.db), {
      id,
      path: relPath,
      title: path.parse(relPath).name,
      // The pre-#5414 write-back left the row typed markdown (#5412).
      fileType: 'markdown',
      attachmentId,
      createdAt: '2026-09-01T00:00:00.000Z',
      modifiedAt: '2026-09-01T00:00:00.000Z'
    })
    return { id, attachmentId, file: path.join(vaultPath, relPath) }
  }

  const restore = () => restoreOverwrittenBinaryNotesWith({ db: asClientDb(testDb.db), vaultPath })

  beforeEach(() => {
    vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-binary-restore-'))
    testDb = createTestDataDb()
    serverBlobs = new Map()
    online = true
    attachmentEvents.onDownloadNeeded(downloader)
  })

  afterEach(() => {
    trackMainLog.mockClear()
    attachmentEvents.offDownloadNeeded(downloader)
    resetAttachmentDownloadSession()
    vi.useRealTimers()
    testDb.close()
    fs.rmSync(vaultPath, { recursive: true, force: true })
  })

  it('downloads the blob back over a PNG the write-back replaced with markdown', async () => {
    const { file } = seedBinaryNote('Sunset.png', WRITEBACK_MARKDOWN)

    expect(await restore()).toEqual({ requested: 1 })
    expect(fs.readFileSync(file)).toEqual(PNG)
  })

  it('restores an empty file, which an empty doc serializes to', async () => {
    const { file } = seedBinaryNote('Empty.png', '')

    await restore()

    expect(fs.readFileSync(file)).toEqual(PNG)
  })

  it('leaves a file the user replaced with other media untouched', async () => {
    const edited = seedBinaryNote('Edited.png', OTHER_PNG)
    const jpegInPng = seedBinaryNote('Camera.png', JPEG)

    expect(await restore()).toEqual({ requested: 0 })
    expect(fs.readFileSync(edited.file)).toEqual(OTHER_PNG)
    expect(fs.readFileSync(jpegInPng.file)).toEqual(JPEG)
  })

  it('never judges SVG, which is text by design', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"></svg>'
    const { file } = seedBinaryNote('Logo.svg', svg)

    expect(await restore()).toEqual({ requested: 0 })
    expect(fs.readFileSync(file, 'utf8')).toBe(svg)
  })

  it('retries a download that failed offline once its backoff opens', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-02T10:00:00.000Z'))
    const { file } = seedBinaryNote('Offline.png', WRITEBACK_MARKDOWN)
    online = false

    expect(await restore()).toEqual({ requested: 1 })
    expect(fs.readFileSync(file, 'utf8')).toBe(WRITEBACK_MARKDOWN)

    // Inside the failure's backoff window nothing is asked again.
    online = true
    expect(await restore()).toEqual({ requested: 0 })

    vi.setSystemTime(new Date('2026-09-02T11:00:00.000Z'))
    expect(await restore()).toEqual({ requested: 1 })
    expect(fs.readFileSync(file)).toEqual(PNG)
  })

  it('stops asking for a blob the server holds as text', async () => {
    const serverText = Buffer.from(WRITEBACK_MARKDOWN)
    const { attachmentId, file } = seedBinaryNote('Uploaded.png', WRITEBACK_MARKDOWN, serverText)

    expect(await restore()).toEqual({ requested: 1 })
    await vi.waitFor(() =>
      expect(
        testDb.sqlite
          .prepare("SELECT value FROM sync_state WHERE key = 'binaryNoteTextBlobs'")
          .get()
      ).toEqual({ value: JSON.stringify([attachmentId]) })
    )

    // The next runtime start (a new session) does not download it again.
    resetAttachmentDownloadSession()
    expect(await restore()).toEqual({ requested: 0 })
    expect(fs.readFileSync(file, 'utf8')).toBe(WRITEBACK_MARKDOWN)
    // The population #5419 needs is counted remotely, not only in the local log.
    expect(trackMainLog).toHaveBeenCalledWith('warn', {
      scope: 'BinaryNoteRestore',
      action: 'binary_note_text_blob',
      metrics: { itemCount: 1 }
    })
  })

  function storeCorruptTextBlobList() {
    testDb.sqlite
      .prepare('INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, ?)')
      .run('binaryNoteTextBlobs', '{not json', Date.now())
  }

  it('restores files over a corrupt text-blob list and reports the list once', async () => {
    storeCorruptTextBlobList()
    const { file } = seedBinaryNote('Sunset.png', WRITEBACK_MARKDOWN)

    expect(await restore()).toEqual({ requested: 1 })
    expect(fs.readFileSync(file)).toEqual(PNG)

    // The next runtime start finds no corrupt list to report again.
    resetAttachmentDownloadSession()
    expect(await restore()).toEqual({ requested: 0 })
    expect(trackMainLog).toHaveBeenCalledTimes(1)
    expect(trackMainLog).toHaveBeenCalledWith('warn', {
      scope: 'BinaryNoteRestore',
      action: 'binary_note_text_blobs_corrupt'
    })
  })

  it('still restores files when the corrupt text-blob list cannot be removed', async () => {
    storeCorruptTextBlobList()
    testDb.sqlite.exec(
      "CREATE TRIGGER keep_sync_state BEFORE DELETE ON sync_state BEGIN SELECT RAISE(ABORT, 'disk is read-only'); END"
    )
    const { file } = seedBinaryNote('Sunset.png', WRITEBACK_MARKDOWN)

    expect(await restore()).toEqual({ requested: 1 })
    expect(fs.readFileSync(file)).toEqual(PNG)
  })
})
