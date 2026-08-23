import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'

// http-client (imported for SyncServerError) pulls electron's `net`.
vi.mock('electron', () => ({ net: { fetch: vi.fn() } }))

import { runMigrations } from '../database/migrate'
import { SyncServerError } from './http-client'
import { DeadLetterError } from './retry'
import { enqueueUpload } from './attachment-outbox'
import {
  MISSING_PROBE_LIMIT,
  clearAttachmentDownloadFailure,
  markDownloadFailed,
  markDownloadRequested,
  markDownloadSucceeded,
  pruneUnresolvableReferences,
  releaseDownloadAttempt,
  resetAttachmentDownloadSession,
  shouldAttemptDownload
} from '@memry/sync-client/attachment-download-state'
import type { DrizzleDb } from '@memry/sync-client/item-handlers/types'

const DAY_MS = 24 * 60 * 60 * 1000
const notFound = (): SyncServerError => new SyncServerError('Failed to fetch manifest', 404)
const serverDown = (): SyncServerError => new SyncServerError('Bad gateway', 502)

/** Every 404 probe the current policy still allows, back to back. */
function exhaustMissingProbes(db: DrizzleDb, noteId: string, attachmentId: string): void {
  for (let i = 0; i < MISSING_PROBE_LIMIT; i++) {
    expect(shouldAttemptDownload(db, noteId, attachmentId)).toBe(true)
    markDownloadRequested(noteId, attachmentId)
    markDownloadFailed(db, noteId, attachmentId, notFound())
    vi.setSystemTime(new Date(Date.now() + DAY_MS + 1000))
  }
}

describe('attachment download state', () => {
  let tempDir: string
  let sqlite: Database.Database
  let db: DrizzleDb

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-19T10:00:00.000Z'))
    resetAttachmentDownloadSession()
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-att-dl-'))
    const dbPath = path.join(tempDir, 'data.db')
    runMigrations(dbPath)
    sqlite = new Database(dbPath)
    db = drizzle(sqlite) as unknown as DrizzleDb
  })

  afterEach(() => {
    vi.useRealTimers()
    resetAttachmentDownloadSession()
    sqlite.close()
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('migration 0051 creates the attachment_download_failures table', () => {
    const row = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
      .get('attachment_download_failures')
    expect(row).toBeTruthy()
  })

  it('attempts a permanent 404 once and does not replay it after a sync stop/start', () => {
    expect(shouldAttemptDownload(db, 'note-1', 'att-dead')).toBe(true)
    markDownloadRequested('note-1', 'att-dead')
    expect(markDownloadFailed(db, 'note-1', 'att-dead', notFound())).toBe('missing')

    // Same session.
    expect(shouldAttemptDownload(db, 'note-1', 'att-dead')).toBe(false)

    // Sync-runtime stop/start (vault switch, sign-out/in, token churn) wipes the
    // in-memory half. This is exactly where the old Set lost the 404.
    resetAttachmentDownloadSession()
    expect(shouldAttemptDownload(db, 'note-1', 'att-dead')).toBe(false)

    // App restart: fresh process state, same data DB on disk.
    resetAttachmentDownloadSession()
    sqlite.close()
    sqlite = new Database(path.join(tempDir, 'data.db'))
    const relaunched = drizzle(sqlite) as unknown as DrizzleDb
    expect(shouldAttemptDownload(relaunched, 'note-1', 'att-dead')).toBe(false)
  })

  it('re-probes a 404 at most once a day and then stops entirely', () => {
    markDownloadRequested('note-1', 'att-dead')
    markDownloadFailed(db, 'note-1', 'att-dead', notFound())

    // An hour later the cooldown has not elapsed.
    vi.setSystemTime(new Date(Date.now() + 60 * 60 * 1000))
    resetAttachmentDownloadSession()
    expect(shouldAttemptDownload(db, 'note-1', 'att-dead')).toBe(false)

    // A day later it gets one more probe.
    vi.setSystemTime(new Date(Date.now() + DAY_MS))
    expect(shouldAttemptDownload(db, 'note-1', 'att-dead')).toBe(true)

    // After MISSING_PROBE_LIMIT probes it is never asked for again.
    markDownloadRequested('note-1', 'att-dead')
    markDownloadFailed(db, 'note-1', 'att-dead', notFound())
    vi.setSystemTime(new Date(Date.now() + DAY_MS))
    markDownloadRequested('note-1', 'att-dead')
    markDownloadFailed(db, 'note-1', 'att-dead', notFound())

    vi.setSystemTime(new Date(Date.now() + 365 * DAY_MS))
    resetAttachmentDownloadSession()
    expect(shouldAttemptDownload(db, 'note-1', 'att-dead')).toBe(false)
  })

  it('keeps retrying a transient failure on a backoff', () => {
    markDownloadRequested('note-1', 'att-flaky')
    expect(markDownloadFailed(db, 'note-1', 'att-flaky', serverDown())).toBe('transient')

    resetAttachmentDownloadSession()
    expect(shouldAttemptDownload(db, 'note-1', 'att-flaky')).toBe(false)

    // First transient backoff is a minute, not a day.
    vi.setSystemTime(new Date(Date.now() + 61 * 1000))
    expect(shouldAttemptDownload(db, 'note-1', 'att-flaky')).toBe(true)

    // Each further failure backs off further, and never becomes terminal.
    markDownloadRequested('note-1', 'att-flaky')
    markDownloadFailed(db, 'note-1', 'att-flaky', serverDown())
    expect(shouldAttemptDownload(db, 'note-1', 'att-flaky')).toBe(false)
    vi.setSystemTime(new Date(Date.now() + 121 * 1000))
    expect(shouldAttemptDownload(db, 'note-1', 'att-flaky')).toBe(true)
  })

  it('treats a dead-lettered 404 as permanent and a dead-lettered 500 as transient', () => {
    expect(markDownloadFailed(db, 'n', 'a', new DeadLetterError(notFound(), 3))).toBe('missing')
    expect(markDownloadFailed(db, 'n', 'b', new DeadLetterError(serverDown(), 3))).toBe('transient')
    expect(markDownloadFailed(db, 'n', 'c', new Error('decrypt failed'))).toBe('transient')
  })

  it('clears the record when the download finally succeeds', () => {
    markDownloadRequested('note-1', 'att-ok')
    markDownloadFailed(db, 'note-1', 'att-ok', serverDown())

    markDownloadRequested('note-1', 'att-ok')
    markDownloadSucceeded(db, 'note-1', 'att-ok')

    const row = sqlite
      .prepare('SELECT * FROM attachment_download_failures WHERE owner_id = ?')
      .get('note-1')
    expect(row).toBeUndefined()
    // Still deduped within the session — the bytes are on disk now.
    expect(shouldAttemptDownload(db, 'note-1', 'att-ok')).toBe(false)
    resetAttachmentDownloadSession()
    expect(shouldAttemptDownload(db, 'note-1', 'att-ok')).toBe(true)
  })

  it('releases an undelivered request so the next pull can ask again', () => {
    markDownloadRequested('note-1', 'att-x')
    expect(shouldAttemptDownload(db, 'note-1', 'att-x')).toBe(false)
    releaseDownloadAttempt('note-1', 'att-x')
    expect(shouldAttemptDownload(db, 'note-1', 'att-x')).toBe(true)
  })

  it('lets a locally uploaded attachment out of a recorded verdict', () => {
    exhaustMissingProbes(db, 'note-1', 'att-back')
    expect(shouldAttemptDownload(db, 'note-1', 'att-back')).toBe(false)

    clearAttachmentDownloadFailure(db, 'note-1', 'att-back')
    resetAttachmentDownloadSession()
    expect(shouldAttemptDownload(db, 'note-1', 'att-back')).toBe(true)
  })
})

describe('pruneUnresolvableReferences', () => {
  let tempDir: string
  let sqlite: Database.Database
  let db: DrizzleDb

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-19T10:00:00.000Z'))
    resetAttachmentDownloadSession()
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-att-prune-'))
    const dbPath = path.join(tempDir, 'data.db')
    runMigrations(dbPath)
    sqlite = new Database(dbPath)
    db = drizzle(sqlite) as unknown as DrizzleDb
  })

  afterEach(() => {
    vi.useRealTimers()
    resetAttachmentDownloadSession()
    sqlite.close()
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('keeps a reference that has simply not uploaded yet', () => {
    // Never probed: no evidence of absence, so nothing may be dropped.
    expect(pruneUnresolvableReferences(db, 'note-1', ['att-new'])).toEqual(['att-new'])

    // And a note whose bytes are still queued for upload is untouchable, even
    // once something about it has 404'd.
    enqueueUpload(db, 'note-2', '/tmp/pending.png')
    exhaustMissingProbes(db, 'note-2', 'att-dead')
    expect(pruneUnresolvableReferences(db, 'note-2', ['att-dead'])).toEqual(['att-dead'])
  })

  it('keeps a reference whose failure is transient', () => {
    for (let i = 0; i < MISSING_PROBE_LIMIT + 2; i++) {
      markDownloadFailed(db, 'note-1', 'att-flaky', serverDown())
      vi.setSystemTime(new Date(Date.now() + 7 * DAY_MS))
    }
    expect(pruneUnresolvableReferences(db, 'note-1', ['att-flaky'])).toEqual(['att-flaky'])
  })

  it('keeps a 404 reference until the probes are exhausted, then drops only that one', () => {
    for (let probe = 1; probe <= MISSING_PROBE_LIMIT; probe++) {
      expect(shouldAttemptDownload(db, 'note-1', 'att-dead')).toBe(true)
      markDownloadRequested('note-1', 'att-dead')
      markDownloadFailed(db, 'note-1', 'att-dead', notFound())

      if (probe < MISSING_PROBE_LIMIT) {
        // One 404 is not yet proof the attachment is gone for good.
        expect(pruneUnresolvableReferences(db, 'note-1', ['att-live', 'att-dead'])).toEqual([
          'att-live',
          'att-dead'
        ])
        vi.setSystemTime(new Date(Date.now() + DAY_MS + 1000))
      }
    }

    expect(pruneUnresolvableReferences(db, 'note-1', ['att-live', 'att-dead'])).toEqual([
      'att-live'
    ])
  })

  it('does not drop another note’s dead reference', () => {
    exhaustMissingProbes(db, 'note-1', 'att-dead')
    expect(pruneUnresolvableReferences(db, 'note-2', ['att-dead'])).toEqual(['att-dead'])
  })
})
