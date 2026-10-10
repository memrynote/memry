import fs from 'fs'
import os from 'os'
import path from 'path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The seam (#3095): right after the outside-vault check resolves a note file,
// the file is swapped for a link to an outside markdown file, before it is read.
const race = vi.hoisted(() => ({ target: '', swap: (): void => {} }))

function swapOnce(probe: unknown): void {
  if (race.target === '' || probe !== race.target) return
  race.target = ''
  race.swap()
}

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  const realpath = async (probe: string): Promise<string> => {
    const real = await actual.realpath(probe)
    swapOnce(probe)
    return real
  }
  return { ...actual, default: { ...actual, realpath }, realpath }
})
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  const native = (probe: string): string => {
    const real = actual.realpathSync.native(probe)
    swapOnce(probe)
    return real
  }
  const realpathSync = Object.assign((probe: string) => actual.realpathSync(probe), { native })
  return { ...actual, default: { ...actual, realpathSync }, realpathSync }
})

const state = vi.hoisted(() => ({ vault: '', rows: [] as { id: string; path: string }[] }))
vi.mock('@main/database/queries/notes', () => ({
  getAllNoteRefRows: () => state.rows
}))
vi.mock('../database', () => ({
  getDatabase: () => ({}),
  getIndexDatabase: () => ({}),
  isDatabaseInitialized: () => true
}))
vi.mock('../vault/notes-io', () => ({
  getVaultRoot: () => state.vault
}))

import { upsertNoteMetadata } from '@memry/storage-data'
import { attachmentFiles } from '@memry/db-schema/data-schema'
import type { DrizzleDb } from '@memry/sync-client/item-handlers/types'
import { runMigrations } from '../database/migrate'
import { backfillUnsyncedAttachmentsWith } from './attachment-backfill'
import { recordAttachmentFile } from './attachment-files'
import { listPendingUploads } from './attachment-outbox'
import { findNotesReferencingAttachment } from '../vault/attachment-reference-scan'

const isWindows = process.platform === 'win32'

describe('a note file swapped for an outside link after the vault check (#3095)', () => {
  let tempDir: string
  let vaultPath: string
  let outside: string
  let secret: string
  let sqlite: Database.Database
  let db: DrizzleDb

  const notePath = (id: string): string => path.join(vaultPath, 'notes', `${id}.md`)

  function addNote(id: string, attachmentReferences: string[] | null = null): void {
    upsertNoteMetadata(db, {
      id,
      path: `notes/${id}.md`,
      title: id,
      createdAt: '2026-08-21T00:00:00.000Z',
      modifiedAt: '2026-08-21T00:00:00.000Z',
      localOnly: false,
      attachmentReferences
    })
    fs.mkdirSync(path.dirname(notePath(id)), { recursive: true })
    fs.writeFileSync(notePath(id), 'vault text\n')
  }

  function arm(id: string): void {
    const file = notePath(id)
    race.target = file
    race.swap = () => {
      fs.rmSync(file)
      fs.symlinkSync(secret, file)
    }
  }

  beforeEach(() => {
    tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memry-swap-att-')))
    vaultPath = path.join(tempDir, 'vault')
    fs.mkdirSync(path.join(vaultPath, 'attachments'), { recursive: true })
    fs.mkdirSync(path.join(vaultPath, 'images'), { recursive: true })
    fs.writeFileSync(path.join(vaultPath, 'images', 'real.png'), 'png')
    const dbPath = path.join(tempDir, 'data.db')
    runMigrations(dbPath)
    sqlite = new Database(dbPath)
    db = drizzle(sqlite) as unknown as DrizzleDb
    state.vault = vaultPath
    state.rows = []
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-swap-att-outside-'))
    secret = path.join(outside, 'private.md')
    fs.writeFileSync(secret, 'outside secret ![x](../images/real.png) attachments/owner/file.png\n')
  })

  afterEach(() => {
    race.target = ''
    sqlite.close()
    fs.rmSync(tempDir, { recursive: true, force: true })
    fs.rmSync(outside, { recursive: true, force: true })
  })

  it.skipIf(isWindows)('the files-on-disk count never counts an outside embed', () => {
    addNote('note-a', ['other-attachment'])
    const landed = path.join(vaultPath, 'attachments', 'note-a', 'x.bin')
    fs.mkdirSync(path.dirname(landed), { recursive: true })
    fs.writeFileSync(landed, 'bytes')
    arm('note-a')

    recordAttachmentFile(db, vaultPath, 'note-a', landed, 'att-1')

    const paths = db
      .select({ path: attachmentFiles.path })
      .from(attachmentFiles)
      .all()
      .map((row) => row.path)
    expect(paths).not.toContain('images/real.png')
  })

  it.skipIf(isWindows)('the backfill never queues an outside embed', () => {
    addNote('note-b')
    arm('note-b')

    backfillUnsyncedAttachmentsWith({ db, vaultPath })

    expect(listPendingUploads(db).map((row) => row.diskPath)).not.toContain(
      path.join(vaultPath, 'images', 'real.png')
    )
  })

  it.skipIf(isWindows)('the reference scan never matches the outside text', () => {
    state.rows = [{ id: 'note-c', path: 'notes/note-c.md' }]
    addNote('note-c')
    arm('note-c')

    const scan = findNotesReferencingAttachment({ ownerNoteId: 'owner', filename: 'file.png' })

    expect(scan.referencedBy).not.toContain('note-c')
    expect(scan.complete).toBe(false)
  })
})
