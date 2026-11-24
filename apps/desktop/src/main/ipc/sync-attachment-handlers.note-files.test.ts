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
import { eq, sql } from 'drizzle-orm'
import { attachmentDownloadFailures, noteMetadata } from '@memry/db-schema'
import { SYNC_CHANNELS, SYNC_EVENTS } from '@memry/contracts/ipc-sync'
import {
  claimRequestedDownload,
  isDownloadAbandoned,
  markDownloadOwed,
  markDownloadRequested,
  holdsDownload,
  pruneUnresolvableReferences,
  resetAttachmentDownloadSession
} from '@memry/sync-client/attachment-download-state'
import { attachmentEvents } from '@memry/sync-client/attachment-events'
import { invokeHandler, mockIpcMain, resetIpcMocks } from '@tests/utils/mock-ipc'
import { createTestDataDb, type TestDataDb } from '../../test/helpers/test-data-db'
import { clearInMemoryAuthState } from './in-memory-auth-state'
import { setSetting } from '../database/queries/settings'
import { recordAttachmentFile } from '../sync/attachment-files'
import { SupersededDownloadError } from '../sync/attachment-errors'
import { redriveAttachmentDownloads } from '../sync/attachment-download-redriver'
import { DOWNLOAD_SETTLE_TIMEOUT_MS } from '../sync/attachment-outbox'
import { recordDownloadedFileSize } from '../sync/note-attachment-metadata'

const h = vi.hoisted(() => ({
  db: null as unknown as TestDataDb,
  /** False once the vault's databases close. */
  dbOpen: true,
  vaultPath: '',
  sent: [] as Array<{ channel: string; payload: unknown }>,
  download: vi.fn(),
  /** The running sync runtime's monitor; null while sync is not running. */
  network: null as object | null,
  token: vi.fn<() => Promise<string | null>>(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
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
  isDatabaseInitialized: () => h.dbOpen
}))
vi.mock('../vault/status', () => ({ getStatus: () => ({ path: h.vaultPath }) }))
vi.mock('../sync/runtime-state', () => ({ getNetworkMonitor: () => h.network }))
vi.mock('../vault/attachment-rename', () => ({ applyDownloadedAttachmentName: vi.fn() }))
vi.mock('../file-text', () => ({ fileTextNoteChanged: vi.fn() }))
vi.mock('../sync/note-attachment-metadata', () => ({
  recordDownloadedFileSize: vi.fn(),
  recordUploadedAttachment: vi.fn()
}))
vi.mock('../lib/logger', () => ({ createLogger: () => h.log }))

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
/** The attachment ids the fake transport was asked for. */
const requested = (): unknown[] => h.download.mock.calls.map(([attachmentId]) => attachmentId)

/** The next token request waits until the test grants it. */
function holdNextToken(): (token: string) => void {
  let grant: (token: string) => void = () => undefined
  h.token.mockReturnValueOnce(
    new Promise((resolve) => {
      grant = resolve
    })
  )
  return (token) => grant(token)
}

/** A pull's request for an embed of `noteId`, with the claim the pull took for it. */
function pullAsksForEmbed(noteId = 'note-1', attachmentId = 'att-embed'): void {
  attachmentEvents.emitDownloadNeeded({
    noteId,
    attachmentId,
    diskPath: path.join(h.vaultPath, 'attachments', noteId),
    intoDir: true,
    claim: markDownloadRequested(noteId, attachmentId)!
  })
}

/** A pull's request for bin-1's own file. */
function pullAsksForBinaryFile(): void {
  attachmentEvents.emitDownloadNeeded({
    noteId: 'bin-1',
    attachmentId: 'att-bin',
    diskPath: pdfPath(),
    claim: markDownloadRequested('bin-1', 'att-bin')!
  })
}

/** Note-1 as the data DB and its file on disk have it now. */
function setNote1(attachmentReferences: string[], body: string): void {
  h.db.update(noteMetadata).set({ attachmentReferences }).where(eq(noteMetadata.id, 'note-1')).run()
  fs.writeFileSync(path.join(h.vaultPath, 'note-1.md'), body)
}

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

/** Every transfer runs until the download queue aborts it. */
function transfersRunUntilAborted(): void {
  h.download.mockImplementation(
    (_attachmentId: string, _targetPath: string, opts?: { signal?: AbortSignal }) =>
      new Promise((_, reject) => {
        opts?.signal?.addEventListener('abort', () => reject(new Error('Aborted')))
      })
  )
}

/**
 * The next transfer runs, deaf to the queue's abort, until the test finishes
 * it: it then lands its file, or fails with `failure`.
 */
function holdNextTransfer(): (failure?: Error) => void {
  let finish: (failure?: Error) => void = () => undefined
  h.download.mockImplementationOnce(
    (attachmentId: string, targetPath: string, opts?: { targetIsDir?: boolean }) =>
      new Promise((resolve, reject) => {
        finish = (failure) => {
          if (failure) return reject(failure)
          const filePath = opts?.targetIsDir ? path.join(targetPath, 'photo.png') : targetPath
          fs.mkdirSync(path.dirname(filePath), { recursive: true })
          fs.writeFileSync(filePath, attachmentId === 'att-embed' ? PNG : PDF)
          resolve({ filePath, manifest: { checksum: `sha-${attachmentId}` } })
        }
      })
  )
  return (failure) => finish(failure)
}

/** Vault A closes and vault B opens; returns vault A's database. */
function switchVault(): TestDataDb {
  const vaultA = h.db
  h.dbOpen = false
  h.db = createTestDataDb()
  h.dbOpen = true
  return vaultA
}

const failureRows = (db: TestDataDb = h.db): unknown[] =>
  db.select().from(attachmentDownloadFailures).all()

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
  h.dbOpen = true
  h.download.mockReset()
  vi.mocked(recordDownloadedFileSize).mockClear()
  h.token.mockReset().mockResolvedValue('token')
  for (const log of Object.values(h.log)) log.mockClear()
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
  void clearAttachmentState()
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

  // With sync running, the downloader checks each embed no record names
  // against the file on disk, and its record keeps the next open local.
  // An open asks again on its own, so a vault switch owes it nothing.
  it('owes nothing for an open a vault switch aborts', async () => {
    transfersRunUntilAborted()
    const open = openNote('bin-1')
    await settle()
    expect(requested()).toEqual(['att-bin'])

    resetAttachmentDownloadSession()
    await clearAttachmentState()

    await expect(open).resolves.toEqual({ success: true })
    expect(failureRows()).toEqual([])
  })

  describe('with sync running, an embed no record names is owed whatever the body shows', () => {
    it('downloads an embed a pull named before its text reached the body', async () => {
      serveFiles()
      const recordedImage = path.join(path.dirname(imagePath()), 'a.png')
      setNote1(['att-a', 'att-new'], '![a](attachments/note-1/a.png)\n')
      fs.mkdirSync(path.dirname(recordedImage), { recursive: true })
      fs.writeFileSync(recordedImage, PNG)
      recordAttachmentFile(h.db, h.vaultPath, 'note-1', recordedImage, 'att-a')

      await expect(openNote('note-1')).resolves.toEqual({ success: true })

      expect(requested()).toEqual(['att-new'])
    })

    it('downloads an embed behind a legacy absolute link that is missing', async () => {
      serveFiles()
      fs.mkdirSync(path.dirname(imagePath()), { recursive: true })
      fs.writeFileSync(imagePath(), PNG)
      const legacy = `memry-file://local${path.join(path.dirname(imagePath()), 'old.png')}`
      setNote1(
        ['att-embed', 'att-old'],
        `![photo](attachments/note-1/photo.png)\n![old](${legacy})\n`
      )

      await expect(openNote('note-1')).resolves.toEqual({ success: true })

      expect(requested()).toContain('att-old')
    })

    it('downloads an embed whose file on disk is empty', async () => {
      serveFiles()
      fs.mkdirSync(path.dirname(imagePath()), { recursive: true })
      fs.writeFileSync(imagePath(), '')

      await expect(openNote('note-1')).resolves.toEqual({ success: true })

      expect(fs.readFileSync(imagePath())).toEqual(PNG)
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
    const grantToken = holdNextToken()

    pullAsksForEmbed()
    resetAttachmentDownloadSession()
    void clearAttachmentState()
    pullAsksForEmbed()
    await settle()
    grantToken('token')
    await settle()

    expect(h.download).toHaveBeenCalledTimes(1)
    expect(h.db.select().from(attachmentDownloadFailures).get()?.attempts).toBe(1)
  })

  // Nothing else asks for it again: the pull's request wrote no row, and with
  // auto-download on an open asks for nothing.
  it('has the re-driver ask for a pull request a runtime restart dropped during its token wait', async () => {
    setAutoDownload(true)
    serveFiles()
    const grantToken = holdNextToken()

    pullAsksForEmbed()
    resetAttachmentDownloadSession()
    void clearAttachmentState()
    grantToken('token')
    await settle()
    expect(h.download).not.toHaveBeenCalled()

    await redriveAttachmentDownloads()
    await settle()

    expect(fs.readFileSync(imagePath())).toEqual(PNG)
  })

  // #5697: the restart rejects both with DownloadQueueClearedError. Nothing
  // else asks for them again: the new runtime's pull starts from its cursor.
  it('has the re-driver land a running and a queued pull request a runtime restart cleared', async () => {
    setAutoDownload(true)
    const now = new Date().toISOString()
    h.db
      .insert(noteMetadata)
      .values(
        ['note-2', 'note-3'].map((id) => ({
          id,
          path: `${id}.md`,
          title: id,
          attachmentReferences: [`att-${id}`],
          createdAt: now,
          modifiedAt: now
        }))
      )
      .run()
    const abortTransfers: Array<() => void> = []
    h.download.mockImplementation(
      () =>
        new Promise((_, reject) => abortTransfers.push(() => reject(new Error('Socket closed'))))
    )

    // Three transfers fill the queue's slots, so note-1's embed waits in it.
    pullAsksForEmbed('note-2', 'att-note-2')
    pullAsksForEmbed('note-3', 'att-note-3')
    pullAsksForBinaryFile()
    pullAsksForEmbed()
    await settle()
    expect(requested()).toEqual(['att-note-2', 'att-note-3', 'att-bin'])

    resetAttachmentDownloadSession()
    void clearAttachmentState()
    for (const abort of abortTransfers) abort()
    await settle()

    // The new runtime starts with the re-driver.
    h.download.mockClear()
    serveFiles()
    await redriveAttachmentDownloads()
    await settle()

    expect(fs.readFileSync(imagePath())).toEqual(PNG)
    expect(fs.readFileSync(pdfPath())).toEqual(PDF)
    expect(requested()).toHaveLength(4)
    expect(new Set(requested())).toEqual(
      new Set(['att-bin', 'att-embed', 'att-note-2', 'att-note-3'])
    )
    expect(h.db.select().from(attachmentDownloadFailures).all()).toEqual([])
    // Landed: the next re-drive asks for nothing.
    await redriveAttachmentDownloads()
    expect(h.download).toHaveBeenCalledTimes(4)
  })

  // REVIEW-5700: owed, the re-driver would download over an edit made to the
  // file since the new runtime landed it.
  it('owes nothing for a dropped pull request the new runtime already landed', async () => {
    setAutoDownload(true)
    serveFiles()
    const grantToken = holdNextToken()

    pullAsksForEmbed()
    resetAttachmentDownloadSession()
    void clearAttachmentState()
    pullAsksForEmbed()
    await settle()
    expect(fs.readFileSync(imagePath())).toEqual(PNG)
    grantToken('token')
    await settle()

    expect(failureRows()).toEqual([])
  })

  it('owes nothing once the new runtime lands a dropped pull request it was downloading', async () => {
    setAutoDownload(true)
    const finish = holdNextTransfer()
    const grantToken = holdNextToken()

    pullAsksForEmbed()
    resetAttachmentDownloadSession()
    void clearAttachmentState()
    pullAsksForEmbed()
    await settle()
    expect(requested()).toEqual(['att-embed'])
    grantToken('token')
    await settle()
    finish()
    await settle()

    expect(fs.readFileSync(imagePath())).toEqual(PNG)
    expect(failureRows()).toEqual([])
  })

  // REVIEW-5700: a transfer that failed after the vault's databases closed
  // wrote no row, so the old vault never asked for it again.
  it('owes a running pull request a vault switch aborts, before the databases close', async () => {
    setAutoDownload(true)
    transfersRunUntilAborted()
    pullAsksForBinaryFile()
    await settle()
    expect(requested()).toEqual(['att-bin'])

    resetAttachmentDownloadSession()
    await clearAttachmentState()
    h.dbOpen = false

    expect(failureRows()).toEqual([expect.objectContaining({ id: 'bin-1::att-bin' })])
  })

  // REVIEW-5722: teardown never waits unbounded; a download outliving its
  // session writes nothing.
  it('stops waiting for a transfer that never settles, owing it first', async () => {
    setAutoDownload(true)
    h.download.mockReturnValue(new Promise(() => undefined))
    pullAsksForBinaryFile()
    await settle()
    resetAttachmentDownloadSession()

    vi.useFakeTimers()
    let cleared = false
    void clearAttachmentState().then(() => {
      cleared = true
    })
    await vi.advanceTimersByTimeAsync(DOWNLOAD_SETTLE_TIMEOUT_MS)

    expect(cleared).toBe(true)
    expect(failureRows()).toEqual([expect.objectContaining({ id: 'bin-1::att-bin' })])
    expect(h.log.warn).toHaveBeenCalledWith(
      expect.stringMatching(/Stopped waiting for downloads/),
      { unsettled: ['bin-1::att-bin'] }
    )
  })

  it('writes nothing into the next vault for transfers that settle after a switch', async () => {
    setAutoDownload(true)
    const landBinary = holdNextTransfer()
    const failEmbed = holdNextTransfer()
    pullAsksForBinaryFile()
    pullAsksForEmbed()
    const tokenWait = holdNextToken()
    pullAsksForEmbed('note-2', 'att-note-2')
    await settle()
    expect(requested()).toEqual(['att-bin', 'att-embed'])

    resetAttachmentDownloadSession()
    await clearAttachmentState(0)
    const vaultA = switchVault()
    landBinary()
    failEmbed(notFound())
    tokenWait('token')
    await settle()

    expect(failureRows()).toEqual([])
    expect(recordDownloadedFileSize).not.toHaveBeenCalled()
    expect(materialized()).toEqual([])
    // Vault A asks for all three again when it next syncs.
    expect(failureRows(vaultA)).toEqual([
      expect.objectContaining({ id: 'bin-1::att-bin', reason: 'transient', attempts: 0 }),
      expect.objectContaining({ id: 'note-1::att-embed', reason: 'transient', attempts: 0 }),
      expect.objectContaining({ id: 'note-2::att-note-2', reason: 'transient', attempts: 0 })
    ])
  })

  // VERIFY-5722: the same vault's database stays open across a runtime
  // restart, so which database is open cannot tell the sessions apart.
  it('writes nothing into the next session for a transfer that settles after a same-vault restart', async () => {
    setAutoDownload(true)
    const landBinary = holdNextTransfer()
    pullAsksForBinaryFile()
    await settle()

    resetAttachmentDownloadSession()
    await clearAttachmentState(0)
    const next = markDownloadRequested('bin-1', 'att-bin')!
    landBinary()
    await settle()

    expect(holdsDownload(next)).toBe(true)
    expect(recordDownloadedFileSize).not.toHaveBeenCalled()
    expect(materialized()).toEqual([])
    expect(failureRows()).toEqual([
      expect.objectContaining({ id: 'bin-1::att-bin', reason: 'transient', attempts: 0 })
    ])
  })

  it('writes nothing into the next session for a transfer that settles after a logout', async () => {
    setAutoDownload(true)
    const landBinary = holdNextTransfer()
    pullAsksForBinaryFile()
    await settle()

    resetAttachmentDownloadSession()
    vi.useFakeTimers()
    clearInMemoryAuthState()
    await vi.advanceTimersByTimeAsync(DOWNLOAD_SETTLE_TIMEOUT_MS)
    vi.useRealTimers()
    const next = markDownloadRequested('bin-1', 'att-bin')!
    landBinary()
    await settle()

    expect(holdsDownload(next)).toBe(true)
    expect(recordDownloadedFileSize).not.toHaveBeenCalled()
    expect(materialized()).toEqual([])
  })

  // The downloader drops a binary note's bytes its note no longer names, its
  // file already holding them or not (#5580).
  it('drops a pull request whose note names another file now, landing nothing', async () => {
    setAutoDownload(true)
    markDownloadOwed(h.db, 'bin-1', 'att-bin')
    h.download.mockRejectedValue(new SupersededDownloadError('bin-1', 'att-bin'))

    pullAsksForBinaryFile()
    await settle()

    expect(failureRows()).toEqual([])
    expect(materialized()).toEqual([])
    // Not recorded as landed: a request for it is still free to ask.
    expect(claimRequestedDownload(h.db, 'bin-1', 'att-bin')).not.toBeNull()
  })

  it('logs a download it cannot record as owed, with the file it is for', async () => {
    setAutoDownload(true)
    const grantToken = holdNextToken()

    pullAsksForEmbed()
    resetAttachmentDownloadSession()
    void clearAttachmentState()
    // The data DB refuses the write as the stale request settles.
    h.db.run(sql`DROP TABLE attachment_download_failures`)
    grantToken('token')
    await settle()

    expect(h.download).not.toHaveBeenCalled()
    expect(h.log.warn).toHaveBeenCalledWith(
      expect.stringMatching(/owed/),
      expect.objectContaining({ noteId: 'note-1', attachmentId: 'att-embed' })
    )
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
