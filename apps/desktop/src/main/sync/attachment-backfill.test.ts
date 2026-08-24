import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { upsertNoteMetadata } from '@memry/storage-data'
import { runMigrations } from '../database/migrate'
import { backfillUnsyncedAttachmentsWith } from './attachment-backfill'
import { listPendingUploads } from './attachment-outbox'
import type { DrizzleDb } from '@memry/sync-client/item-handlers/types'

describe('attachment backfill', () => {
  let tempDir: string
  let vaultPath: string
  let sqlite: Database.Database
  let db: DrizzleDb

  const addNote = (
    id: string,
    overrides: { localOnly?: boolean; attachmentReferences?: string[] } = {}
  ): void => {
    upsertNoteMetadata(db, {
      id,
      path: `notes/${id}.md`,
      title: id,
      createdAt: '2026-08-21T00:00:00.000Z',
      modifiedAt: '2026-08-21T00:00:00.000Z',
      localOnly: overrides.localOnly ?? false,
      attachmentReferences: overrides.attachmentReferences ?? null
    })
  }

  const addFile = (noteId: string, filename: string): string => {
    const dir = path.join(vaultPath, 'attachments', noteId)
    fs.mkdirSync(dir, { recursive: true })
    const filePath = path.join(dir, filename)
    fs.writeFileSync(filePath, 'bytes')
    return filePath
  }

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-backfill-'))
    vaultPath = path.join(tempDir, 'vault')
    fs.mkdirSync(path.join(vaultPath, 'attachments'), { recursive: true })
    const dbPath = path.join(tempDir, 'data.db')
    runMigrations(dbPath)
    sqlite = new Database(dbPath)
    db = drizzle(sqlite) as unknown as DrizzleDb
  })

  afterEach(() => {
    sqlite.close()
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('queues attachments of a note the server has never been told about', () => {
    // The exact shape of the outage: the note synced, its files did not.
    addNote('note-a')
    const image = addFile('note-a', 'nl5coy-images.jpeg')
    const pdf = addFile('note-a', 'zs0ae5-sample-local-pdf.pdf')

    const result = backfillUnsyncedAttachmentsWith({ db, vaultPath })

    expect(result).toEqual({ scanned: 1, queued: 2 })
    expect(
      listPendingUploads(db)
        .map((row) => row.diskPath)
        .sort()
    ).toEqual([image, pdf].sort())
  })

  it('leaves a note that already has references alone', () => {
    // Its attachment id is random, not derived from the bytes, so re-uploading
    // to be sure would duplicate in R2 whatever is already up there.
    addNote('note-b', { attachmentReferences: ['already-uploaded'] })
    addFile('note-b', 'seen.png')

    expect(backfillUnsyncedAttachmentsWith({ db, vaultPath })).toEqual({ scanned: 0, queued: 0 })
    expect(listPendingUploads(db)).toHaveLength(0)
  })

  it('never queues a local-only note', () => {
    addNote('note-c', { localOnly: true })
    addFile('note-c', 'private.png')

    expect(backfillUnsyncedAttachmentsWith({ db, vaultPath })).toEqual({ scanned: 0, queued: 0 })
    expect(listPendingUploads(db)).toHaveLength(0)
  })

  it('ignores folders that are not notes and dotfiles that are not attachments', () => {
    // `attachments/inbox`, `attachments/images` and .DS_Store all live here.
    fs.mkdirSync(path.join(vaultPath, 'attachments', 'inbox'), { recursive: true })
    fs.writeFileSync(path.join(vaultPath, 'attachments', 'inbox', 'stray.png'), 'bytes')
    fs.writeFileSync(path.join(vaultPath, 'attachments', '.DS_Store'), 'junk')
    addNote('note-d')
    const real = addFile('note-d', 'keep.png')
    fs.writeFileSync(path.join(vaultPath, 'attachments', 'note-d', '.DS_Store'), 'junk')

    const result = backfillUnsyncedAttachmentsWith({ db, vaultPath })

    expect(result).toEqual({ scanned: 1, queued: 1 })
    expect(listPendingUploads(db).map((row) => row.diskPath)).toEqual([real])
  })

  it('is safe to run again before the outbox has drained', () => {
    addNote('note-e')
    addFile('note-e', 'once.png')

    backfillUnsyncedAttachmentsWith({ db, vaultPath })
    backfillUnsyncedAttachmentsWith({ db, vaultPath })

    expect(listPendingUploads(db)).toHaveLength(1)
  })

  it('returns empty for a vault with no attachments folder at all', () => {
    fs.rmSync(path.join(vaultPath, 'attachments'), { recursive: true, force: true })

    expect(backfillUnsyncedAttachmentsWith({ db, vaultPath })).toEqual({ scanned: 0, queued: 0 })
  })
})
