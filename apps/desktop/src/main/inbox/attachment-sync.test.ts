/**
 * Inbox attachment sync (#4157) on a real data DB and a real vault folder.
 * Only the transfer queues are faked: they are proven by their own suites.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InboxChannels } from '@memry/contracts/ipc-channels'
import { inboxAttachmentUploads, inboxItems } from '@memry/db-schema/schema/inbox'
import { SyncServerError } from '@memry/sync-client/http-errors'
import { createTestDataDb, type TestDataDb } from '../../test/helpers/test-data-db'

vi.mock('electron', () => ({ net: { fetch: vi.fn() } }))
vi.mock('../database/client', () => ({ getDatabase: vi.fn(), isDatabaseInitialized: () => true }))
vi.mock('../vault/status', () => ({ getStatus: () => ({ path: null }) }))
vi.mock('../sync/runtime-state', () => ({ getSyncEngine: () => null }))
vi.mock('../sync/attachment-files', () => ({ recordAttachmentFile: vi.fn() }))
vi.mock('../sync/note-attachment-metadata', () => ({ recordUploadedAttachment: vi.fn() }))

const effects = vi.hoisted(() => ({ syncInboxUpdate: vi.fn(), publishInboxUpserted: vi.fn() }))
vi.mock('./runtime-effects', () => effects)

const broadcast = vi.hoisted(() => vi.fn())
vi.mock('../lib/window-broadcast', () => ({ broadcastToAllWindows: broadcast }))

import {
  queueInboxAttachmentUpload,
  reconcileInboxAttachments,
  type InboxAttachmentIO
} from './attachment-sync'

const ITEM = 'item-1'
const FILE = 'ab12cd-photo.png'

let db: TestDataDb
let vaultPath: string
let io: {
  uploadAttachment: ReturnType<typeof vi.fn<InboxAttachmentIO['uploadAttachment']>>
  downloadAttachmentIntoDir: ReturnType<
    typeof vi.fn<InboxAttachmentIO['downloadAttachmentIntoDir']>
  >
}

const itemDir = (id = ITEM) => path.join(vaultPath, 'attachments', 'inbox', id)
const row = (id = ITEM) => db.select().from(inboxItems).where(eq(inboxItems.id, id)).get()
const pending = () =>
  db
    .select()
    .from(inboxAttachmentUploads)
    .all()
    .map((r) => r.itemId)

/** A capture on this device: the row, the file on disk, and the pending mark. */
function capture(overrides: Partial<typeof inboxItems.$inferInsert> = {}, withFile = true): void {
  const id = overrides.id ?? ITEM
  db.insert(inboxItems)
    .values({
      id,
      type: 'image',
      title: 'Photo',
      attachmentPath: `attachments/inbox/${id}/${FILE}`,
      ...overrides
    })
    .run()
  if (withFile) {
    mkdirSync(itemDir(id), { recursive: true })
    writeFileSync(path.join(itemDir(id), FILE), 'bytes')
  }
  queueInboxAttachmentUpload(db, id)
}

/** An item pulled from a peer: the row with an attachment id, and no file yet. */
function pulled(overrides: Partial<typeof inboxItems.$inferInsert> = {}): void {
  db.insert(inboxItems)
    .values({ id: ITEM, type: 'image', title: 'Photo', attachmentId: 'att-1', ...overrides })
    .run()
}

const reconcile = () => reconcileInboxAttachments({ db, vaultPath, io })

beforeEach(() => {
  vaultPath = mkdtempSync(path.join(tmpdir(), 'inbox-attachment-sync-'))
  db = createTestDataDb()
  io = {
    uploadAttachment: vi.fn(async () => ({ attachmentId: 'att-1' })),
    downloadAttachmentIntoDir: vi.fn(async (_owner, _id, dir) => {
      writeFileSync(path.join(dir, FILE), 'remote bytes')
      return { filePath: path.join(dir, FILE) }
    })
  }
  effects.syncInboxUpdate.mockClear()
  effects.publishInboxUpserted.mockClear()
  broadcast.mockClear()
})

afterEach(() => {
  rmSync(vaultPath, { recursive: true, force: true })
})

describe('queueInboxAttachmentUpload', () => {
  it('marks a capture pending once, however often it is called', () => {
    db.insert(inboxItems).values({ id: ITEM, type: 'image', title: 'Photo' }).run()

    queueInboxAttachmentUpload(db, ITEM)
    queueInboxAttachmentUpload(db, ITEM)

    expect(pending()).toEqual([ITEM])
  })

  it('drops the mark with its item', () => {
    capture()

    db.delete(inboxItems).where(eq(inboxItems.id, ITEM)).run()

    expect(pending()).toEqual([])
  })
})

describe('uploading a pending capture', () => {
  it('uploads the file, records the attachment id, and pushes the item', async () => {
    capture()

    await reconcile()

    expect(io.uploadAttachment).toHaveBeenCalledWith(ITEM, path.join(itemDir(), FILE))
    expect(row()?.attachmentId).toBe('att-1')
    expect(pending()).toEqual([])
    expect(effects.syncInboxUpdate).toHaveBeenCalledWith(ITEM)
    expect(broadcast).toHaveBeenCalledWith(InboxChannels.events.UPDATED, { id: ITEM })
  })

  it('leaves the item local-only when the server refuses it for storage quota', async () => {
    capture()
    io.uploadAttachment.mockRejectedValue(
      new SyncServerError('quota', 413, 'STORAGE_QUOTA_EXCEEDED: out of space')
    )

    await reconcile()
    await reconcile()

    expect(io.uploadAttachment).toHaveBeenCalledTimes(1)
    expect(row()?.attachmentId).toBeNull()
    expect(pending()).toEqual([])
    expect(effects.syncInboxUpdate).not.toHaveBeenCalled()
  })

  it('keeps the mark after a transient failure and uploads on the next pass', async () => {
    capture()
    io.uploadAttachment.mockRejectedValueOnce(new SyncServerError('down', 503))

    await reconcile()
    expect(pending()).toEqual([ITEM])
    expect(row()?.attachmentId).toBeNull()

    await reconcile()
    expect(row()?.attachmentId).toBe('att-1')
    expect(pending()).toEqual([])
  })

  it.each([
    ['the file is gone', () => capture({}, false)],
    ['the item was filed', () => capture({ filedAt: '2026-01-01T00:00:00.000Z' })],
    ['the item never leaves the device', () => capture({ localOnly: true })],
    ['the item already has an id', () => capture({ attachmentId: 'att-old' })]
  ])('drops the mark without uploading when %s', async (_name, setup) => {
    setup()

    await reconcile()

    expect(io.uploadAttachment).not.toHaveBeenCalled()
    expect(pending()).toEqual([])
  })

  it('does not record an id for an item filed while its upload ran', async () => {
    capture()
    io.uploadAttachment.mockImplementation(async () => {
      db.update(inboxItems)
        .set({ filedAt: '2026-01-01T00:00:00.000Z' })
        .where(eq(inboxItems.id, ITEM))
        .run()
      return { attachmentId: 'att-1' }
    })

    await reconcile()

    expect(row()?.attachmentId).toBeNull()
    expect(pending()).toEqual([])
    expect(effects.syncInboxUpdate).not.toHaveBeenCalled()
  })

  it('does nothing while sync cannot transfer', async () => {
    capture()

    await reconcileInboxAttachments({ db, vaultPath, io: null })

    expect(pending()).toEqual([ITEM])
  })
})

describe('downloading a pulled capture', () => {
  it('lands the file under attachments/inbox/<id>/ and points the row at it', async () => {
    pulled()

    await reconcile()

    expect(io.downloadAttachmentIntoDir).toHaveBeenCalledWith(ITEM, 'att-1', itemDir())
    expect(existsSync(path.join(itemDir(), FILE))).toBe(true)
    expect(row()?.attachmentPath).toBe(`attachments/inbox/${ITEM}/${FILE}`)
    expect(effects.publishInboxUpserted).toHaveBeenCalledWith(ITEM)
    expect(broadcast).toHaveBeenCalledWith(InboxChannels.events.UPDATED, { id: ITEM })
  })

  it('refuses a download that lands outside the item folder', async () => {
    pulled()
    io.downloadAttachmentIntoDir.mockResolvedValue({
      filePath: path.join(vaultPath, 'notes', 'evil.md')
    })

    await reconcile()

    expect(row()?.attachmentPath).toBeNull()
    expect(broadcast).not.toHaveBeenCalled()
  })

  it('refuses an item id that would name a folder elsewhere', async () => {
    pulled({ id: '..' })

    await reconcile()

    expect(io.downloadAttachmentIntoDir).not.toHaveBeenCalled()
  })

  it('skips an item whose file is already on disk', async () => {
    pulled({ attachmentPath: `attachments/inbox/${ITEM}/${FILE}` })
    mkdirSync(itemDir(), { recursive: true })
    writeFileSync(path.join(itemDir(), FILE), 'local bytes')

    await reconcile()

    expect(io.downloadAttachmentIntoDir).not.toHaveBeenCalled()
  })

  it('does not download for a filed item, whose file belongs to a note', async () => {
    pulled({ filedAt: '2026-01-01T00:00:00.000Z' })

    await reconcile()

    expect(io.downloadAttachmentIntoDir).not.toHaveBeenCalled()
  })

  it('discards a file that finished downloading after the item was filed', async () => {
    pulled()
    io.downloadAttachmentIntoDir.mockImplementation(async (_owner, _id, dir) => {
      db.update(inboxItems)
        .set({ filedAt: '2026-01-01T00:00:00.000Z' })
        .where(eq(inboxItems.id, ITEM))
        .run()
      writeFileSync(path.join(dir, FILE), 'late bytes')
      return { filePath: path.join(dir, FILE) }
    })

    await reconcile()

    expect(existsSync(path.join(itemDir(), FILE))).toBe(false)
    expect(row()?.attachmentPath).toBeNull()
  })

  it('retries on the next pass after a failed download', async () => {
    pulled()
    io.downloadAttachmentIntoDir.mockRejectedValueOnce(new Error('offline'))

    await reconcile()
    expect(row()?.attachmentPath).toBeNull()

    await reconcile()
    expect(row()?.attachmentPath).toBe(`attachments/inbox/${ITEM}/${FILE}`)
  })
})
