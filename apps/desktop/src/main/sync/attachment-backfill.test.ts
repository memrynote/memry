import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { upsertNoteMetadata } from '@memry/storage-data'
import { runMigrations } from '../database/migrate'
import { attachmentEvents } from '@memry/sync-client/attachment-events'
import { backfillUnsyncedAttachmentsWith, queueEmbeddedVaultFilesWith } from './attachment-backfill'
import { clearUpload, listPendingUploads, markUploadFailed } from './attachment-outbox'
import { recordAttachmentFile, referencedVaultFiles } from './attachment-files'
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

    expect(backfillUnsyncedAttachmentsWith({ db, vaultPath })).toEqual({ scanned: 1, queued: 1 })
    // The file already has a row: nothing new is queued, so nothing is logged.
    expect(backfillUnsyncedAttachmentsWith({ db, vaultPath })).toEqual({ scanned: 0, queued: 0 })

    expect(listPendingUploads(db)).toHaveLength(1)
  })

  const writeNote = (id: string, body: string): void => {
    fs.mkdirSync(path.join(vaultPath, 'notes'), { recursive: true })
    fs.writeFileSync(path.join(vaultPath, 'notes', `${id}.md`), body)
  }

  const writeVaultFile = (relative: string): string => {
    const file = path.join(vaultPath, relative)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, 'bytes')
    return file
  }

  it('queues a file the body embeds from outside the note folder', () => {
    // An imported note: its picture sits beside it, not in attachments/<id>/,
    // so the folder scan never saw it and no other device could fetch it.
    addNote('note-f')
    const picture = writeVaultFile('notes/images/photo.png')
    const pdf = writeVaultFile('docs/spec.pdf')
    writeNote(
      'note-f',
      [
        '![A photo](images/photo.png)',
        '<!-- file:{"url":"../docs/spec.pdf","name":"spec.pdf"} -->',
        '![remote](https://example.com/x.png)',
        '![missing](images/gone.png)'
      ].join('\n\n')
    )

    const result = backfillUnsyncedAttachmentsWith({ db, vaultPath })

    expect(result.queued).toBe(2)
    expect(
      listPendingUploads(db)
        .map((row) => row.diskPath)
        .sort()
    ).toEqual([picture, pdf].sort())
  })

  it('queues an embed added to a note that a previous pass found without one', () => {
    addNote('note-h')
    writeNote('note-h', 'plain text, nothing embedded')
    expect(backfillUnsyncedAttachmentsWith({ db, vaultPath }).queued).toBe(0)

    const picture = writeVaultFile('notes/images/added-later.png')
    writeNote('note-h', 'plain text, now with ![a picture](images/added-later.png)')

    expect(backfillUnsyncedAttachmentsWith({ db, vaultPath }).queued).toBe(1)
    expect(listPendingUploads(db).map((row) => row.diskPath)).toEqual([picture])
  })

  it('queues an embedded file that reaches the disk after the note that embeds it', () => {
    addNote('note-i')
    writeNote('note-i', '![copied in later](images/late.png)')
    expect(backfillUnsyncedAttachmentsWith({ db, vaultPath }).queued).toBe(0)

    const picture = writeVaultFile('notes/images/late.png')

    expect(backfillUnsyncedAttachmentsWith({ db, vaultPath }).queued).toBe(1)
    expect(listPendingUploads(db).map((row) => row.diskPath)).toEqual([picture])
  })

  // A note that already holds an attachment reference used to be skipped
  // whole, so a file added to it without a save event never left the device.
  // The record of which files went up or came down is what tells them apart.
  describe('notes that already hold attachment references (#2651)', () => {
    const queuedPaths = (): string[] =>
      listPendingUploads(db)
        .map((row) => row.diskPath)
        .sort()

    it('queues only the file the record does not know', () => {
      addNote('note-k', { attachmentReferences: ['att-1'] })
      const uploaded = addFile('note-k', 'aaaaaa-first.png')
      recordAttachmentFile(db, vaultPath, 'note-k', uploaded, 'att-1')
      const added = addFile('note-k', 'bbbbbb-added.png')

      expect(backfillUnsyncedAttachmentsWith({ db, vaultPath }).queued).toBe(1)
      expect(queuedPaths()).toEqual([added])
    })

    it('counts the files of a note from before the record and queues what comes after', () => {
      addNote('note-old', { attachmentReferences: ['att-old'] })
      addFile('note-old', 'cccccc-old.png')
      writeVaultFile('notes/images/old-embed.png')
      writeNote('note-old', '![old](images/old-embed.png)')

      expect(backfillUnsyncedAttachmentsWith({ db, vaultPath }).queued).toBe(0)

      const added = addFile('note-old', 'dddddd-new.png')
      expect(backfillUnsyncedAttachmentsWith({ db, vaultPath }).queued).toBe(1)
      expect(queuedPaths()).toEqual([added])
    })

    it('counts a note from before the record even when it had no file on disk yet', () => {
      addNote('note-empty', { attachmentReferences: ['att-remote'] })
      expect(backfillUnsyncedAttachmentsWith({ db, vaultPath }).queued).toBe(0)

      const added = addFile('note-empty', 'eeeeee-later.png')
      expect(backfillUnsyncedAttachmentsWith({ db, vaultPath }).queued).toBe(1)
      expect(queuedPaths()).toEqual([added])
    })

    it('counts the other files of an older note when its first new upload is recorded', () => {
      addNote('note-first', { attachmentReferences: ['att-before', 'att-new'] })
      addFile('note-first', 'ffffff-before.png')
      const fresh = addFile('note-first', 'gggggg-fresh.png')

      recordAttachmentFile(db, vaultPath, 'note-first', fresh, 'att-new')

      expect(backfillUnsyncedAttachmentsWith({ db, vaultPath }).queued).toBe(0)
    })

    it('treats a renamed file that keeps its stored prefix as the same file', () => {
      addNote('note-rn', { attachmentReferences: ['att-rn'] })
      const original = addFile('note-rn', 'hhhhhh-draft.png')
      recordAttachmentFile(db, vaultPath, 'note-rn', original, 'att-rn')
      fs.renameSync(original, path.join(path.dirname(original), 'hhhhhh-final.png'))

      expect(backfillUnsyncedAttachmentsWith({ db, vaultPath }).queued).toBe(0)
      expect(backfillUnsyncedAttachmentsWith({ db, vaultPath }).queued).toBe(0)
    })

    it('does not queue a file again once its upload is recorded', () => {
      addNote('note-up')
      const file = addFile('note-up', 'iiiiii-up.png')
      expect(backfillUnsyncedAttachmentsWith({ db, vaultPath }).queued).toBe(1)
      clearUpload(db, 'note-up', file)
      recordAttachmentFile(db, vaultPath, 'note-up', file, 'att-up')

      expect(backfillUnsyncedAttachmentsWith({ db, vaultPath }).queued).toBe(0)
    })

    it('queues a file a written body embeds on a note with a recorded upload', () => {
      addNote('note-wb', { attachmentReferences: ['att-wb'] })
      const first = addFile('note-wb', 'jjjjjj-first.png')
      recordAttachmentFile(db, vaultPath, 'note-wb', first, 'att-wb')
      const picture = writeVaultFile('notes/images/wb.png')

      expect(
        queueEmbeddedVaultFilesWith({ db, vaultPath }, 'note-wb', '![wb](images/wb.png)')
      ).toBe(1)
      expect(queuedPaths()).toEqual([picture])
    })
  })

  // Another note's folder belongs to that note; its file is already that
  // note's attachment, and queuing it here would upload a second copy.
  it("leaves out a file from another note's attachments folder that a body embeds", () => {
    addNote('note-owner')
    const shared = addFile('note-owner', 'kkkkkk-shared.png')
    addNote('note-embedder', { attachmentReferences: ['att-e'] })
    recordAttachmentFile(
      db,
      vaultPath,
      'note-embedder',
      addFile('note-embedder', 'llllll-own.png'),
      'att-e'
    )
    writeNote('note-embedder', '![shared](../attachments/note-owner/kkkkkk-shared.png)')
    addNote('note-fresh')
    writeNote('note-fresh', '![shared](../attachments/note-owner/kkkkkk-shared.png)')

    backfillUnsyncedAttachmentsWith({ db, vaultPath })
    queueEmbeddedVaultFilesWith(
      { db, vaultPath },
      'note-embedder',
      '![shared](../attachments/note-owner/kkkkkk-shared.png)'
    )

    expect(listPendingUploads(db)).toEqual([
      { noteId: 'note-owner', diskPath: shared, attempts: 0 }
    ])
  })

  it("leaves a failed row's retry window alone when it finds the file again", () => {
    addNote('note-retry')
    const file = addFile('note-retry', 'mmmmmm-retry.png')
    markUploadFailed(db, 'note-retry', file, 'server said no')
    sqlite.prepare('UPDATE attachment_upload_queue SET updated_at = 5').run()

    backfillUnsyncedAttachmentsWith({ db, vaultPath })

    expect(
      sqlite.prepare('SELECT attempts, updated_at FROM attachment_upload_queue').all()
    ).toEqual([{ attempts: 1, updated_at: 5 }])
  })

  describe('when a body is written (#2651)', () => {
    const saved: Array<{ noteId: string; diskPath: string }> = []
    const onSaved = (event: { noteId: string; diskPath: string }): void => {
      saved.push(event)
    }

    beforeEach(() => {
      saved.length = 0
      attachmentEvents.onSaved(onSaved)
    })

    afterEach(() => {
      attachmentEvents.removeAllListeners('saved')
    })

    it('queues and announces each embedded vault file once', () => {
      addNote('note-w')
      const picture = writeVaultFile('notes/images/written.png')
      const body = '![a](images/written.png)\n\n![gone](images/gone.png)'

      expect(queueEmbeddedVaultFilesWith({ db, vaultPath }, 'note-w', body)).toBe(1)
      expect(queueEmbeddedVaultFilesWith({ db, vaultPath }, 'note-w', body)).toBe(0)

      expect(saved).toEqual([{ noteId: 'note-w', diskPath: picture }])
      expect(listPendingUploads(db).map((row) => row.diskPath)).toEqual([picture])
    })

    it("queues a file in the note's own folder that no save event announced", () => {
      addNote('note-o')
      const artifact = addFile('note-o', 'artifact.html')
      const body = '<!-- file:{"url":"attachments/note-o/artifact.html","name":"artifact.html"} -->'

      expect(queueEmbeddedVaultFilesWith({ db, vaultPath }, 'note-o', body)).toBe(1)
      expect(saved).toEqual([{ noteId: 'note-o', diskPath: artifact }])
    })

    it('leaves alone an older note with references, a local-only note and an unknown note', () => {
      addNote('note-r', { attachmentReferences: ['already-uploaded'] })
      addNote('note-l', { localOnly: true })
      writeVaultFile('notes/images/held.png')
      const body = '![a](images/held.png)'

      expect(queueEmbeddedVaultFilesWith({ db, vaultPath }, 'note-r', body)).toBe(0)
      expect(queueEmbeddedVaultFilesWith({ db, vaultPath }, 'note-l', body)).toBe(0)
      expect(queueEmbeddedVaultFilesWith({ db, vaultPath }, 'note-missing', body)).toBe(0)
      expect(saved).toEqual([])
      expect(listPendingUploads(db)).toEqual([])
    })
  })

  it('does not scan the body of a note that already has references', () => {
    addNote('note-g', { attachmentReferences: ['already-uploaded'] })
    writeVaultFile('notes/images/other.png')
    writeNote('note-g', '![x](images/other.png)')

    expect(backfillUnsyncedAttachmentsWith({ db, vaultPath }).queued).toBe(0)
  })

  it('reads the root-relative attachments form and refuses a path out of the vault', () => {
    const files = referencedVaultFiles(
      '![a](attachments/n1/a%20b.png)\n\n![b](../../etc/passwd)\n\n![c](/abs.png)',
      vaultPath,
      'notes/n1.md',
      'n1'
    )
    expect(files).toEqual([path.join(path.resolve(vaultPath), 'attachments', 'n1', 'a b.png')])
  })

  it('returns empty for a vault with no attachments folder at all', () => {
    fs.rmSync(path.join(vaultPath, 'attachments'), { recursive: true, force: true })

    expect(backfillUnsyncedAttachmentsWith({ db, vaultPath })).toEqual({ scanned: 0, queued: 0 })
  })
})
