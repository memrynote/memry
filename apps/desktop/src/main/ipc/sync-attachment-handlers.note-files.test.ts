/**
 * #5616: with attachment auto-download off, opening a note is what downloads
 * its files. Driven through the real IPC handler, with a real data DB, a temp
 * vault, the real download queue, download-state guard and attachment record.
 * Only the transport (`AttachmentSyncService.downloadAttachment`) is faked: it
 * writes the file where the real one would.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { attachmentDownloadFailures, noteMetadata } from '@memry/db-schema'
import { SYNC_CHANNELS, SYNC_EVENTS } from '@memry/contracts/ipc-sync'
import {
  isDownloadAbandoned,
  markDownloadRequested,
  pruneUnresolvableReferences,
  resetAttachmentDownloadSession
} from '@memry/sync-client/attachment-download-state'
import { attachmentEvents } from '@memry/sync-client/attachment-events'
import { invokeHandler, mockIpcMain, resetIpcMocks } from '@tests/utils/mock-ipc'
import { createTestDataDb, type TestDataDb } from '../../test/helpers/test-data-db'
import { setSetting } from '../database/queries/settings'
import { recordAttachmentFile } from '../sync/attachment-files'

const h = vi.hoisted(() => ({
  db: null as unknown as TestDataDb,
  vaultPath: '',
  sent: [] as Array<{ channel: string; payload: unknown }>,
  download: vi.fn(),
  /** The running sync runtime's monitor; null while sync is not running. */
  network: null as object | null,
  token: vi.fn<() => Promise<string | null>>()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: Parameters<typeof mockIpcMain.handle>[1]) =>
      mockIpcMain.handle(channel, handler),
    removeHandler: (channel: string) => mockIpcMain.removeHandler(channel)
  },
  BrowserWindow: {
    getAllWindows: () => [
      {
        isDestroyed: () => false,
        webContents: {
          send: (channel: string, payload: unknown) => h.sent.push({ channel, payload })
        }
      }
    ]
  },
  net: { fetch: vi.fn() }
}))
vi.mock('../sync/attachments', () => ({
  AttachmentSyncService: vi.fn().mockImplementation(function AttachmentSyncServiceFake() {
    return { downloadAttachment: h.download, setProgressCallback: vi.fn() }
  }),
  AttachmentTooLargeError: class AttachmentTooLargeError extends Error {}
}))
vi.mock('../sync/token-manager', () => ({ getValidAccessToken: () => h.token() }))
vi.mock('../database/client', () => ({
  getDatabase: () => h.db,
  isDatabaseInitialized: () => true
}))
vi.mock('../vault/status', () => ({ getStatus: () => ({ path: h.vaultPath }) }))
vi.mock('../sync/runtime-state', () => ({ getNetworkMonitor: () => h.network }))
vi.mock('../vault/attachment-rename', () => ({ applyDownloadedAttachmentName: vi.fn() }))
vi.mock('../file-text', () => ({ fileTextNoteChanged: vi.fn() }))
vi.mock('../sync/note-attachment-metadata', () => ({
  recordDownloadedFileSize: vi.fn(),
  recordUploadedAttachment: vi.fn()
}))
vi.mock('../lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

import {
  clearAttachmentState,
  registerAttachmentHandlers,
  unregisterAttachmentHandlers
} from './sync-attachment-handlers'

const PDF = Buffer.from('%PDF-1.4 report')
const PNG = Buffer.from('png bytes')
const DAY_MS = 24 * 60 * 60 * 1000
const notFound = (): Error =>
  Object.assign(new Error('Failed to fetch manifest'), { statusCode: 404 })
/** Every request the fake transport serves settles on microtasks. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

type Result = { success: boolean; error?: string; retry?: string }
const openNote = (noteId: string): Promise<Result> =>
  invokeHandler<Result>(SYNC_CHANNELS.DOWNLOAD_NOTE_FILES, { noteId })

const imagePath = (): string => path.join(h.vaultPath, 'attachments', 'note-1', 'photo.png')
const pdfPath = (): string => path.join(h.vaultPath, 'files', 'report.pdf')
const materialized = (): unknown[] =>
  h.sent.filter((m) => m.channel === SYNC_EVENTS.ATTACHMENT_MATERIALIZED).map((m) => m.payload)

function setAutoDownload(on: boolean): void {
  setSetting(h.db, 'sync', JSON.stringify({ attachmentAutoDownload: on }))
}

/** The fake transport: writes the bytes where the real downloader would. */
function serveFiles(): void {
  h.download.mockImplementation(
    async (attachmentId: string, targetPath: string, opts?: { targetIsDir?: boolean }) => {
      const filePath = opts?.targetIsDir ? path.join(targetPath, 'photo.png') : targetPath
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(filePath, attachmentId === 'att-embed' ? PNG : PDF)
      return { filePath, manifest: { checksum: `sha-${attachmentId}` } }
    }
  )
}

/** The server answered 404 for the binary note's file on all three days. */
function abandonBinaryNoteFile(): void {
  h.db
    .insert(attachmentDownloadFailures)
    .values({
      id: 'bin-1::att-bin',
      ownerId: 'bin-1',
      attachmentId: 'att-bin',
      reason: 'missing',
      attempts: 3,
      lastError: 'Not found',
      nextAttemptAt: null,
      updatedAt: Date.now()
    })
    .run()
}

beforeEach(() => {
  resetIpcMocks()
  resetAttachmentDownloadSession()
  h.sent = []
  h.download.mockReset()
  h.token.mockReset().mockResolvedValue('token')
  h.network = Object.assign(new EventEmitter(), { online: true })
  h.db = createTestDataDb()
  h.vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-note-files-'))
  const now = new Date().toISOString()
  h.db
    .insert(noteMetadata)
    .values([
      {
        id: 'note-1',
        path: 'note-1.md',
        title: 'note-1',
        attachmentReferences: ['att-embed'],
        createdAt: now,
        modifiedAt: now
      },
      {
        id: 'bin-1',
        path: 'files/report.pdf',
        title: 'report',
        fileType: 'pdf',
        fileSize: PDF.length,
        attachmentId: 'att-bin',
        createdAt: now,
        modifiedAt: now
      }
    ])
    .run()
  fs.writeFileSync(path.join(h.vaultPath, 'note-1.md'), '![photo](attachments/note-1/photo.png)\n')
  setAutoDownload(false)
  registerAttachmentHandlers()
})

afterEach(() => {
  vi.useRealTimers()
  unregisterAttachmentHandlers()
  clearAttachmentState()
  resetAttachmentDownloadSession()
  fs.rmSync(h.vaultPath, { recursive: true, force: true })
})

describe('sync:download-note-files with auto-download off', () => {
  it('downloads the embed and the binary note file once, and tells the windows', async () => {
    serveFiles()

    await expect(openNote('note-1')).resolves.toEqual({ success: true })
    await expect(openNote('bin-1')).resolves.toEqual({ success: true })

    expect(fs.readFileSync(imagePath())).toEqual(PNG)
    expect(fs.readFileSync(pdfPath())).toEqual(PDF)
    expect(materialized()).toEqual([{ noteId: 'note-1' }, { noteId: 'bin-1' }])

    // Opening again after a restart asks for nothing: both files are held.
    resetAttachmentDownloadSession()
    await expect(openNote('note-1')).resolves.toEqual({ success: true })
    await expect(openNote('bin-1')).resolves.toEqual({ success: true })
    expect(h.download).toHaveBeenCalledTimes(2)
  })

  it('reports a failure, then Try again downloads without waiting out the backoff', async () => {
    h.download.mockRejectedValueOnce(new Error('R2 unavailable'))

    await expect(openNote('bin-1')).resolves.toEqual({
      success: false,
      error: 'R2 unavailable',
      retry: 'now'
    })
    expect(fs.existsSync(pdfPath())).toBe(false)
    const failure = h.db.select().from(attachmentDownloadFailures).get()
    expect(failure?.nextAttemptAt).toBeGreaterThan(Date.now())

    serveFiles()
    await expect(openNote('bin-1')).resolves.toEqual({ success: true })
    expect(fs.readFileSync(pdfPath())).toEqual(PDF)
    expect(h.db.select().from(attachmentDownloadFailures).all()).toEqual([])
  })

  it('reports a file the server no longer has without asking for it', async () => {
    abandonBinaryNoteFile()

    const result = await openNote('bin-1')

    expect(result).toEqual({
      success: false,
      error: expect.stringMatching(/no longer on the sync server/),
      retry: 'none'
    })
    expect(h.download).not.toHaveBeenCalled()
  })

  // A 404 is asked again once a day, three days running, before the file is
  // given up and its reference dropped from the note. Opening the note must
  // not spend those three probes in seconds.
  it('asks the server once a day for a file it answered 404, however often it is opened', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    h.download.mockRejectedValue(notFound())

    for (let open = 0; open < 3; open++) {
      await expect(openNote('note-1')).resolves.toEqual({
        success: false,
        error: expect.stringMatching(/isn't on the sync server yet/),
        retry: 'none'
      })
    }

    expect(h.download).toHaveBeenCalledTimes(1)
    expect(isDownloadAbandoned(h.db, 'note-1', 'att-embed')).toBe(false)
    expect(pruneUnresolvableReferences(h.db, 'note-1', ['att-embed'])).toEqual(['att-embed'])

    // A day later the next open asks again.
    vi.setSystemTime(Date.now() + DAY_MS + 1000)
    await openNote('note-1')
    expect(h.download).toHaveBeenCalledTimes(2)
  })

  it('asks the server nothing while sync is not running, then downloads once it runs', async () => {
    h.network = null
    serveFiles()

    await expect(openNote('bin-1')).resolves.toEqual({
      success: false,
      error: expect.stringMatching(/Sync isn't running.+once sync runs/),
      retry: 'whenSyncRuns'
    })
    expect(h.download).not.toHaveBeenCalled()

    // The sync runtime starts; the open asks again (the renderer, on the status change).
    h.network = Object.assign(new EventEmitter(), { online: true })
    await expect(openNote('bin-1')).resolves.toEqual({ success: true })
    expect(fs.readFileSync(pdfPath())).toEqual(PDF)
  })

  // A note from before the attachment record (#2651) has no record of its
  // embeds, and a held vault or a plan without sync never runs sync.
  it('owes nothing while sync is off when every file an unrecorded note embeds is on disk', async () => {
    h.network = null
    fs.mkdirSync(path.dirname(imagePath()), { recursive: true })
    fs.writeFileSync(imagePath(), PNG)

    await expect(openNote('note-1')).resolves.toEqual({ success: true })

    fs.rmSync(imagePath())
    await expect(openNote('note-1')).resolves.toMatchObject({
      success: false,
      retry: 'whenSyncRuns'
    })

    // A record names exactly which file is the attachment's: gone, it is owed.
    fs.writeFileSync(imagePath(), PNG)
    const recorded = path.join(path.dirname(imagePath()), 'old.png')
    recordAttachmentFile(h.db, h.vaultPath, 'note-1', recorded, 'att-embed')
    await expect(openNote('note-1')).resolves.toMatchObject({
      success: false,
      retry: 'whenSyncRuns'
    })
  })

  // A pull's request for a file is released before it waits for a token, so
  // an open of the note right then claims and downloads it instead of finding
  // it held by a request that downloads nothing.
  it('downloads a file a suppressed pull request still waits on a token for', async () => {
    serveFiles()
    // A token asked for during the pull's request never comes.
    let pulling = true
    h.token.mockImplementation(() =>
      pulling ? new Promise<string | null>(() => undefined) : Promise.resolve('token')
    )
    attachmentEvents.emitDownloadNeeded({
      noteId: 'note-1',
      attachmentId: 'att-embed',
      diskPath: path.join(h.vaultPath, 'attachments', 'note-1'),
      intoDir: true,
      claim: markDownloadRequested('note-1', 'att-embed')!
    })
    pulling = false

    await expect(openNote('note-1')).resolves.toEqual({ success: true })
    expect(fs.readFileSync(imagePath())).toEqual(PNG)
  })
})

describe('sync:download-note-files with auto-download on', () => {
  it('leaves the downloads to the background', async () => {
    setAutoDownload(true)
    serveFiles()

    await expect(openNote('note-1')).resolves.toEqual({ success: true })
    await expect(openNote('bin-1')).resolves.toEqual({ success: true })

    expect(h.download).not.toHaveBeenCalled()
    expect(fs.existsSync(imagePath())).toBe(false)
  })

  // The runtime teardown drops every claim, and the next runtime's pull asks
  // again: the server's 404 counts once, not once per runtime.
  it('counts one 404 for a pull request that waited for its token across a runtime restart', async () => {
    setAutoDownload(true)
    h.download.mockRejectedValue(notFound())
    let grantToken: (token: string) => void = () => undefined
    h.token.mockReturnValueOnce(
      new Promise((resolve) => {
        grantToken = resolve
      })
    )
    const pullAsks = (): void => {
      attachmentEvents.emitDownloadNeeded({
        noteId: 'note-1',
        attachmentId: 'att-embed',
        diskPath: path.join(h.vaultPath, 'attachments', 'note-1'),
        intoDir: true,
        claim: markDownloadRequested('note-1', 'att-embed')!
      })
    }

    pullAsks()
    resetAttachmentDownloadSession()
    clearAttachmentState()
    pullAsks()
    await settle()
    grantToken('token')
    await settle()

    expect(h.download).toHaveBeenCalledTimes(1)
    expect(h.db.select().from(attachmentDownloadFailures).get()?.attempts).toBe(1)
  })

  it('reports a file the server no longer has, which the pull never downloaded', async () => {
    setAutoDownload(true)
    abandonBinaryNoteFile()

    await expect(openNote('bin-1')).resolves.toEqual({
      success: false,
      error: expect.stringMatching(/no longer on the sync server/),
      retry: 'none'
    })
  })
})
