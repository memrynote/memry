import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { upsertNoteMetadata } from '@memry/storage-data'
import { runMigrations } from '../database/migrate'
import {
  enqueueUpload,
  clearUpload,
  markUploadFailed,
  listPendingUploads,
  drainOutboxWith,
  dropUploadsWithoutFile,
  queueUploadIfAbsent,
  isLocalOnlyNote,
  registerOutboxUploader
} from './attachment-outbox'
import type { DrizzleDb } from '@memry/sync-client/item-handlers/types'

describe('attachment outbox', () => {
  let rootDir: string
  let tempDir: string
  let sqlite: Database.Database
  let db: DrizzleDb

  // The vault holds its data database in `.memry`, like a real one.
  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-outbox-'))
    tempDir = path.join(rootDir, 'vault')
    fs.mkdirSync(path.join(tempDir, '.memry'), { recursive: true })
    const dbPath = path.join(tempDir, '.memry', 'data.db')
    runMigrations(dbPath)
    sqlite = new Database(dbPath)
    db = drizzle(sqlite) as unknown as DrizzleDb
  })

  afterEach(() => {
    registerOutboxUploader(null, null, null)
    sqlite.close()
    fs.rmSync(rootDir, { recursive: true, force: true })
  })

  it('migration 0039 creates the attachment_upload_queue table', () => {
    const row = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
      .get('attachment_upload_queue')
    expect(row).toBeTruthy()
  })

  it('persists an upload intent once per (note, path) pair', () => {
    enqueueUpload(db, 'note-1', '/tmp/a.pdf')
    enqueueUpload(db, 'note-1', '/tmp/a.pdf')
    enqueueUpload(db, 'note-1', '/tmp/b.png')

    const pending = listPendingUploads(db)
    expect(pending).toHaveLength(2)
    expect(pending.map((p) => p.diskPath).sort()).toEqual(['/tmp/a.pdf', '/tmp/b.png'])
  })

  it('clearUpload removes the row; markUploadFailed upserts and counts attempts', () => {
    enqueueUpload(db, 'note-1', '/tmp/a.pdf')
    clearUpload(db, 'note-1', '/tmp/a.pdf')
    expect(listPendingUploads(db)).toHaveLength(0)

    markUploadFailed(db, 'note-2', '/tmp/c.pdf', 'boom')
    markUploadFailed(db, 'note-2', '/tmp/c.pdf', 'boom again')
    const pending = listPendingUploads(db)
    expect(pending).toHaveLength(1)
    expect(pending[0].attempts).toBe(2)
  })

  it('keeps the row of a local-only note on the device and never uploads it', async () => {
    upsertNoteMetadata(db, {
      id: 'note-local',
      path: 'notes/note-local.md',
      title: 'note-local',
      createdAt: '2026-08-21T00:00:00.000Z',
      modifiedAt: '2026-08-21T00:00:00.000Z',
      localOnly: true,
      attachmentReferences: null
    })
    const file = path.join(tempDir, 'artifact.html')
    fs.writeFileSync(file, '<p>x</p>')
    enqueueUpload(db, 'note-local', file)
    const upload = vi.fn(async () => ({ attachmentId: 'id' }))

    await drainOutboxWith({ db, vaultPath: tempDir, upload })

    expect(upload).not.toHaveBeenCalled()
    expect(listPendingUploads(db)).toHaveLength(1)
    expect(isLocalOnlyNote(db, 'note-local')).toBe(true)
    expect(isLocalOnlyNote(db, 'note-missing')).toBe(false)
  })

  it('still drains other rows when more than a batch of local-only rows waits', async () => {
    upsertNoteMetadata(db, {
      id: 'note-local',
      path: 'notes/note-local.md',
      title: 'note-local',
      createdAt: '2026-08-21T00:00:00.000Z',
      modifiedAt: '2026-08-21T00:00:00.000Z',
      localOnly: true,
      attachmentReferences: null
    })
    for (let i = 0; i < 60; i++) {
      const file = path.join(tempDir, `local-${i}.png`)
      fs.writeFileSync(file, 'x')
      enqueueUpload(db, 'note-local', file)
    }
    const synced = path.join(tempDir, 'synced.png')
    fs.writeFileSync(synced, 'y')
    enqueueUpload(db, 'note-synced', synced)
    const upload = vi.fn(async () => ({ attachmentId: 'id-synced' }))

    await expect(drainOutboxWith({ db, vaultPath: tempDir, upload })).resolves.toEqual({
      uploaded: 1,
      failed: 0,
      dropped: 0
    })
    expect(upload).toHaveBeenCalledWith('note-synced', synced)
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM attachment_upload_queue').get()).toEqual({
      n: 60
    })
  })

  it('skips a row that another upload cleared while the drain was busy (#2651)', async () => {
    const first = path.join(tempDir, 'first.png')
    const second = path.join(tempDir, 'second.png')
    fs.writeFileSync(first, 'a')
    fs.writeFileSync(second, 'b')
    enqueueUpload(db, 'note-1', first)
    enqueueUpload(db, 'note-1', second)
    const upload = vi.fn(async (_noteId: string, diskPath: string) => {
      // The save path finishes the second file and clears its row meanwhile.
      if (diskPath === first) clearUpload(db, 'note-1', second)
      return { attachmentId: `id-${path.basename(diskPath)}` }
    })

    await expect(drainOutboxWith({ db, vaultPath: tempDir, upload })).resolves.toEqual({
      uploaded: 1,
      failed: 0,
      dropped: 0
    })
    expect(upload.mock.calls).toEqual([['note-1', first]])
  })

  it('drops a row whose file is deleted while its upload waits, recording no failure', async () => {
    const deleted = path.join(tempDir, 'deleted.png')
    fs.writeFileSync(deleted, 'a')
    enqueueUpload(db, 'note-1', deleted)
    const upload = vi.fn(async () => {
      fs.rmSync(deleted)
      throw Object.assign(new Error(`ENOENT: no such file, stat '${deleted}'`), { code: 'ENOENT' })
    })

    await expect(drainOutboxWith({ db, vaultPath: tempDir, upload })).resolves.toEqual({
      uploaded: 0,
      failed: 0,
      dropped: 1
    })
    expect(listPendingUploads(db)).toEqual([])
  })

  it('leaves a row alone, attempts unchanged, when its upload belongs to the save path', async () => {
    const owned = path.join(tempDir, 'owned.png')
    fs.writeFileSync(owned, 'a')
    enqueueUpload(db, 'note-1', owned)
    const onUploaded = vi.fn()

    await expect(
      drainOutboxWith({ db, vaultPath: tempDir, upload: async () => null, onUploaded })
    ).resolves.toEqual({
      uploaded: 0,
      failed: 0,
      dropped: 0
    })
    expect(onUploaded).not.toHaveBeenCalled()
    expect(listPendingUploads(db)).toEqual([{ noteId: 'note-1', diskPath: owned, attempts: 0 }])
  })

  // Like failed downloads (#2651): a row that keeps failing waits longer each
  // time instead of being re-read and re-sent on every five-minute pass.
  it('holds a failed row back until its retry window opens, doubling with each failure', async () => {
    const failing = path.join(tempDir, 'failing.png')
    fs.writeFileSync(failing, 'a')
    markUploadFailed(db, 'note-1', failing, 'server said no')
    markUploadFailed(db, 'note-1', failing, 'server said no')
    const failedAt = 1_000_000
    sqlite.prepare('UPDATE attachment_upload_queue SET updated_at = ?').run(failedAt)
    const upload = vi.fn(async () => ({ attachmentId: 'att-1' }))

    await drainOutboxWith({ db, vaultPath: tempDir, upload, now: failedAt + 119_000 })
    expect(upload).not.toHaveBeenCalled()

    await drainOutboxWith({ db, vaultPath: tempDir, upload, now: failedAt + 120_000 })
    expect(upload.mock.calls).toEqual([['note-1', failing]])
  })

  it('caps the retry window at six hours', async () => {
    const failing = path.join(tempDir, 'capped.png')
    fs.writeFileSync(failing, 'a')
    for (let i = 0; i < 20; i++) markUploadFailed(db, 'note-1', failing, 'server said no')
    sqlite.prepare('UPDATE attachment_upload_queue SET updated_at = 0').run()
    const upload = vi.fn(async () => ({ attachmentId: 'att-1' }))

    await drainOutboxWith({ db, vaultPath: tempDir, upload, now: 6 * 60 * 60 * 1000 - 1 })
    expect(upload).not.toHaveBeenCalled()
    await drainOutboxWith({ db, vaultPath: tempDir, upload, now: 6 * 60 * 60 * 1000 })
    expect(upload).toHaveBeenCalledTimes(1)
  })

  it('queues a row only when none exists, keeping a failed row and its window', () => {
    markUploadFailed(db, 'note-1', '/tmp/kept.png', 'server said no')
    sqlite.prepare('UPDATE attachment_upload_queue SET updated_at = 5').run()

    queueUploadIfAbsent(db, 'note-1', '/tmp/kept.png')
    queueUploadIfAbsent(db, 'note-1', '/tmp/new.png')

    expect(
      sqlite
        .prepare(
          'SELECT disk_path, attempts, updated_at FROM attachment_upload_queue ORDER BY disk_path'
        )
        .all()
    ).toEqual([
      { disk_path: '/tmp/kept.png', attempts: 1, updated_at: 5 },
      { disk_path: '/tmp/new.png', attempts: 0, updated_at: expect.any(Number) }
    ])
  })

  it('drainOutboxWith retries pending rows: success clears, failure stays, missing file drops', () => {
    const okPath = path.join(tempDir, 'ok.pdf')
    const failPath = path.join(tempDir, 'fail.pdf')
    const gonePath = path.join(tempDir, 'gone.pdf')
    fs.writeFileSync(okPath, 'ok')
    fs.writeFileSync(failPath, 'fail')

    enqueueUpload(db, 'note-ok', okPath)
    enqueueUpload(db, 'note-fail', failPath)
    enqueueUpload(db, 'note-gone', gonePath)

    const onUploaded = vi.fn()
    const upload = vi.fn(async (_noteId: string, diskPath: string) => {
      if (diskPath === failPath) throw new Error('server said no')
      return { attachmentId: 'att-' + path.basename(diskPath) }
    })

    return drainOutboxWith({ db, vaultPath: tempDir, upload, onUploaded }).then((result) => {
      expect(result).toEqual({ uploaded: 1, failed: 1, dropped: 1 })
      expect(onUploaded).toHaveBeenCalledWith('note-ok', 'att-ok.pdf')

      const pending = listPendingUploads(db)
      expect(pending).toHaveLength(1)
      expect(pending[0].noteId).toBe('note-fail')
      expect(pending[0].attempts).toBe(1)

      // gone.pdf row dropped without calling upload for it
      expect(upload).toHaveBeenCalledTimes(2)
    })
  })

  // A removable or network vault that is away for a moment hides every file
  // at once; its rows must still upload once it is back.
  it('keeps every row, attempts unchanged, while the vault is unreachable', async () => {
    const file = path.join(tempDir, 'attachments', 'note-1', 'photo.png')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, 'a')
    enqueueUpload(db, 'note-1', file)
    registerOutboxUploader(
      async () => ({ attachmentId: 'id' }),
      () => db,
      null
    )
    const away = path.join(rootDir, 'vault-away')
    fs.renameSync(tempDir, away)
    const upload = vi.fn(async () => ({ attachmentId: 'id' }))

    dropUploadsWithoutFile(tempDir)
    await expect(drainOutboxWith({ db, vaultPath: tempDir, upload })).resolves.toEqual({
      uploaded: 0,
      failed: 0,
      dropped: 0
    })
    expect(upload).not.toHaveBeenCalled()
    expect(listPendingUploads(db)).toEqual([{ noteId: 'note-1', diskPath: file, attempts: 0 }])

    fs.renameSync(away, tempDir)
    await expect(drainOutboxWith({ db, vaultPath: tempDir, upload })).resolves.toEqual({
      uploaded: 1,
      failed: 0,
      dropped: 0
    })
    expect(upload.mock.calls).toEqual([['note-1', file]])
    expect(listPendingUploads(db)).toEqual([])
  })

  it("keeps the row while the folder of the file's note is unreachable", async () => {
    upsertNoteMetadata(db, {
      id: 'note-usb',
      path: 'usb/note-usb.md',
      title: 'note-usb',
      createdAt: '2026-08-21T00:00:00.000Z',
      modifiedAt: '2026-08-21T00:00:00.000Z',
      attachmentReferences: null
    })
    const file = path.join(tempDir, 'usb', 'scan.pdf')
    enqueueUpload(db, 'note-usb', file)
    registerOutboxUploader(
      async () => ({ attachmentId: 'id' }),
      () => db,
      null
    )
    const upload = vi.fn(async () => ({ attachmentId: 'id' }))

    dropUploadsWithoutFile(tempDir)
    await drainOutboxWith({ db, vaultPath: tempDir, upload })

    expect(upload).not.toHaveBeenCalled()
    expect(listPendingUploads(db)).toEqual([{ noteId: 'note-usb', diskPath: file, attempts: 0 }])
  })

  it('drops the row of a file deleted from a reachable vault', () => {
    const kept = path.join(tempDir, 'kept.png')
    fs.writeFileSync(kept, 'a')
    enqueueUpload(db, 'note-1', kept)
    enqueueUpload(db, 'note-1', path.join(tempDir, 'deleted.png'))
    registerOutboxUploader(
      async () => ({ attachmentId: 'id' }),
      () => db,
      null
    )

    dropUploadsWithoutFile(tempDir)

    expect(listPendingUploads(db)).toEqual([{ noteId: 'note-1', diskPath: kept, attempts: 0 }])
  })
})
