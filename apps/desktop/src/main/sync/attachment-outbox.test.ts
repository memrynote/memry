import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { runMigrations } from '../database/migrate'
import {
  enqueueUpload,
  clearUpload,
  markUploadFailed,
  listPendingUploads,
  drainOutboxWith
} from './attachment-outbox'
import type { DrizzleDb } from './item-handlers/types'

describe('attachment outbox', () => {
  let tempDir: string
  let sqlite: Database.Database
  let db: DrizzleDb

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-outbox-'))
    const dbPath = path.join(tempDir, 'data.db')
    runMigrations(dbPath)
    sqlite = new Database(dbPath)
    db = drizzle(sqlite) as unknown as DrizzleDb
  })

  afterEach(() => {
    sqlite.close()
    fs.rmSync(tempDir, { recursive: true, force: true })
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

    return drainOutboxWith({ db, upload, onUploaded }).then((result) => {
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
})
