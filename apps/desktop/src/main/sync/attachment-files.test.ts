import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { upsertNoteMetadata } from '@memry/storage-data'
import { runMigrations } from '../database/migrate'
import { backfillUnsyncedAttachmentsWith } from './attachment-backfill'
import { enqueueUpload, listPendingUploads } from './attachment-outbox'
import {
  placeDownloadedFile,
  placeLinkedDownloads,
  recordAttachmentFile,
  recordedFileOf,
  reusableAttachmentIds
} from './attachment-files'
import type { DrizzleDb } from '@memry/sync-client/item-handlers/types'

describe('placeDownloadedFile', () => {
  let tempDir: string
  let vaultPath: string
  let sqlite: Database.Database
  let db: DrizzleDb

  const addNote = (id: string, body: string): string => {
    upsertNoteMetadata(db, {
      id,
      path: `notes/${id}.md`,
      title: id,
      createdAt: '2026-10-08T00:00:00.000Z',
      modifiedAt: '2026-10-08T00:00:00.000Z',
      attachmentReferences: ['att-1']
    })
    const notePath = path.join(vaultPath, 'notes', `${id}.md`)
    fs.mkdirSync(path.dirname(notePath), { recursive: true })
    fs.writeFileSync(notePath, body)
    return notePath
  }

  const download = (noteId: string, filename: string, bytes = 'downloaded'): string => {
    const dir = path.join(vaultPath, 'attachments', noteId)
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, filename)
    fs.writeFileSync(file, bytes)
    return file
  }

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-place-'))
    vaultPath = path.join(tempDir, 'vault')
    fs.mkdirSync(vaultPath, { recursive: true })
    const dbPath = path.join(tempDir, 'data.db')
    runMigrations(dbPath)
    sqlite = new Database(dbPath)
    db = drizzle(sqlite) as unknown as DrizzleDb
  })

  afterEach(() => {
    sqlite.close()
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('moves the file to the free vault path the body links, and the body is not rewritten', async () => {
    const body = '# Sources\n\n![x](../sources/x.txt)\n'
    const notePath = addNote('note-a', body)
    const landed = download('note-a', 'x.txt')

    const placed = await placeDownloadedFile(db, vaultPath, 'note-a', landed)

    const linked = path.join(vaultPath, 'sources', 'x.txt')
    expect(placed).toBe(linked)
    expect(fs.readFileSync(linked, 'utf8')).toBe('downloaded')
    expect(fs.existsSync(landed)).toBe(false)
    expect(fs.readFileSync(notePath, 'utf8')).toBe(body)
  })

  it('reads the file block marker too', async () => {
    addNote('note-a', '<!-- file:{"url":"../sources/report.csv","name":"report.csv"} -->\n')
    const landed = download('note-a', 'report.csv')

    const placed = await placeDownloadedFile(db, vaultPath, 'note-a', landed)

    expect(placed).toBe(path.join(vaultPath, 'sources', 'report.csv'))
  })

  it('keeps the file where it landed when the linked path is taken', async () => {
    addNote('note-a', '![x](../sources/x.txt)\n')
    fs.mkdirSync(path.join(vaultPath, 'sources'))
    fs.writeFileSync(path.join(vaultPath, 'sources', 'x.txt'), 'already here')
    const landed = download('note-a', 'x.txt')

    const placed = await placeDownloadedFile(db, vaultPath, 'note-a', landed)

    expect(placed).toBe(landed)
    expect(fs.readFileSync(landed, 'utf8')).toBe('downloaded')
    expect(fs.readFileSync(path.join(vaultPath, 'sources', 'x.txt'), 'utf8')).toBe('already here')
  })

  it('keeps the file where it landed when the linked folder is a symlink out of the vault', async () => {
    const outside = path.join(tempDir, 'outside')
    fs.mkdirSync(outside)
    fs.symlinkSync(outside, path.join(vaultPath, 'sources'), 'dir')
    addNote('note-a', '![x](../sources/x.txt)\n')
    const landed = download('note-a', 'x.txt')

    const placed = await placeDownloadedFile(db, vaultPath, 'note-a', landed)

    expect(placed).toBe(landed)
    expect(fs.readdirSync(outside)).toEqual([])
  })

  it('keeps a file the vault lists as its own note where it landed', async () => {
    // sources/photo.png is a file note on the device that uploaded it, and it
    // reaches this device at that path through its own sync.
    addNote('note-a', '![p](../sources/photo.png)\n')
    const landed = download('note-a', 'photo.png')

    const placed = await placeDownloadedFile(db, vaultPath, 'note-a', landed)

    expect(placed).toBe(landed)
    expect(fs.existsSync(path.join(vaultPath, 'sources', 'photo.png'))).toBe(false)
  })

  it('keeps the file where it landed when two links share its name', async () => {
    addNote('note-a', '![a](../one/x.txt)\n![b](../two/x.txt)\n')
    const landed = download('note-a', 'x.txt')

    const placed = await placeDownloadedFile(db, vaultPath, 'note-a', landed)

    expect(placed).toBe(landed)
    expect(fs.existsSync(path.join(vaultPath, 'one'))).toBe(false)
    expect(fs.existsSync(path.join(vaultPath, 'two'))).toBe(false)
  })

  it('keeps a file the body links in the note folder where it landed', async () => {
    addNote('note-a', '![x](../attachments/note-a/x.txt)\n')
    const landed = download('note-a', 'x.txt')

    expect(await placeDownloadedFile(db, vaultPath, 'note-a', landed)).toBe(landed)
  })

  it('keeps a file the body also links where it landed', async () => {
    addNote('note-a', '![x](../attachments/note-a/x.txt)\n![y](../sources/x.txt)\n')
    const landed = download('note-a', 'x.txt')

    expect(await placeDownloadedFile(db, vaultPath, 'note-a', landed)).toBe(landed)
  })

  it('places a download that landed before its body arrived, and moves its record', async () => {
    const notePath = addNote('note-a', 'body\n')
    const landed = download('note-a', 'x.txt')
    recordAttachmentFile(db, vaultPath, 'note-a', landed, 'att-1')

    fs.writeFileSync(notePath, '![x](../sources/x.txt)\n')
    await placeLinkedDownloads(db, vaultPath, 'note-a')

    const linked = path.join(vaultPath, 'sources', 'x.txt')
    expect(fs.readFileSync(linked, 'utf8')).toBe('downloaded')
    expect(fs.existsSync(landed)).toBe(false)
    expect(recordedFileOf(db, vaultPath, 'note-a', 'att-1')).toBe(linked)
    expect(backfillUnsyncedAttachmentsWith({ db, vaultPath }).queued).toBe(0)
  })

  it("offers the note's attachments for a file outside its folder only", () => {
    addNote('note-a', '![x](../sources/x.txt)\n')

    expect(
      reusableAttachmentIds(db, vaultPath, 'note-a', path.join(vaultPath, 'sources', 'x.txt'))
    ).toEqual(['att-1'])
    expect(
      reusableAttachmentIds(
        db,
        vaultPath,
        'note-a',
        path.join(vaultPath, 'attachments', 'note-a', 'pasted.png')
      )
    ).toEqual([])
  })

  it('queues no upload for an embed whose file note syncs its own bytes', () => {
    upsertNoteMetadata(db, {
      id: 'trip',
      path: 'notes/trip.md',
      title: 'trip',
      createdAt: '2026-10-08T00:00:00.000Z',
      modifiedAt: '2026-10-08T00:00:00.000Z'
    })
    fs.mkdirSync(path.join(vaultPath, 'notes'), { recursive: true })
    fs.writeFileSync(
      path.join(vaultPath, 'notes', 'trip.md'),
      [
        '![p](../sources/photo.png)',
        '![s](../sources/scan.pdf)',
        '![o](../sources/old.png)',
        '![d](../sources/data.txt)'
      ].join('\n')
    )
    const source = (name: string): string => path.join(vaultPath, 'sources', name)
    fs.mkdirSync(path.join(vaultPath, 'sources'), { recursive: true })
    for (const name of ['photo.png', 'scan.pdf', 'old.png', 'data.txt']) {
      fs.writeFileSync(source(name), name)
    }
    const fileNote = (id: string, name: string, attachmentId: string | null): void => {
      upsertNoteMetadata(db, {
        id,
        path: `sources/${name}`,
        title: id,
        fileType: name.endsWith('.pdf') ? 'pdf' : 'image',
        attachmentId,
        createdAt: '2026-10-08T00:00:00.000Z',
        modifiedAt: '2026-10-08T00:00:00.000Z'
      })
    }
    // Uploaded already, on its way, and indexed at startup with no upload of
    // its own: only the last still needs the embed to carry its bytes.
    fileNote('photo', 'photo.png', 'att-photo')
    fileNote('scan', 'scan.pdf', null)
    enqueueUpload(db, 'scan', source('scan.pdf'))
    fileNote('old', 'old.png', null)

    backfillUnsyncedAttachmentsWith({ db, vaultPath })

    expect(
      listPendingUploads(db)
        .map((row) => `${row.noteId} ${path.basename(row.diskPath)}`)
        .sort()
    ).toEqual(['scan scan.pdf', 'trip data.txt', 'trip old.png'])
  })

  it('a placed and recorded file is not uploaded again', async () => {
    addNote('note-a', '![x](../sources/x.txt)\n')
    const landed = download('note-a', 'x.txt')

    const placed = await placeDownloadedFile(db, vaultPath, 'note-a', landed)
    recordAttachmentFile(db, vaultPath, 'note-a', placed, 'att-1')

    expect(backfillUnsyncedAttachmentsWith({ db, vaultPath }).queued).toBe(0)
    expect(listPendingUploads(db)).toEqual([])
  })
})
