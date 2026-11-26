/**
 * Nothing of a stray leaves the device, whatever runs first (#5607). A stray
 * is a binary note row an older Windows build made of a pasted attachment, at
 * `attachments/<noteId>/<file>`. The vault open forgets the rows
 * (`forgetStrayAttachmentRows`), but the sync runtime starts beside that pass,
 * so here it has not run: the older build's leftovers are still queued. The
 * sync queue, the record push, the note-body outbox, the upload outbox and the
 * note sync service are real; crypto and HTTP are stubbed.
 *
 * @module sync/stray-attachment-push.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import * as Y from 'yjs'
import { syncDevices } from '@memry/db-schema/schema/sync-devices'
import { attachmentUploadQueue } from '@memry/db-schema/schema/attachment-upload-queue'
import { deletedAssetReleases } from '@memry/db-schema'
import { upsertNoteMetadata } from '@memry/storage-data'
import { SyncQueueManager } from '@memry/sync-client/queue'
import { createMockDeps } from '@tests/utils/engine-mocks'
import {
  asClientDb,
  asSyncDb,
  createTestDataDb,
  createTestIndexDb,
  type TestDatabaseResult
} from '@tests/utils/test-db'

vi.mock('../database/client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getDatabase: vi.fn(),
  getIndexDatabase: vi.fn(),
  isDatabaseInitialized: () => true,
  isIndexDatabaseInitialized: () => true
}))
vi.mock('../telemetry/diagnostics', () => ({ trackMainError: vi.fn(), trackMainLog: vi.fn() }))

import { getDatabase, getIndexDatabase } from '../database/client'
import { drainOutboxWith, queueUploadIfAbsent } from './attachment-outbox'
import { recordDeletedItemAssets } from './deleted-asset-release'
import type { EncryptItemInput } from './encrypt'
import { SyncEngine } from './engine'
import { NoteBodyOutbox, type NoteBodyPushFn } from './note-body-outbox'
import { isBinaryNote } from './note-body-apply'
import { initNoteSyncService, resetNoteSyncService } from './note-sync'
import { buildContentDeletePayload } from './pending-deletes'

const STRAY = 'attachments/host/abc-pasted.png'

describe('a stray attachment row before the vault-open pass forgets it', () => {
  let data: TestDatabaseResult
  let index: TestDatabaseResult
  let vaultPath: string
  let queue: SyncQueueManager

  beforeEach(() => {
    data = createTestDataDb()
    index = createTestIndexDb()
    vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-stray-push-'))
    vi.mocked(getDatabase).mockReturnValue(asClientDb(data.db))
    vi.mocked(getIndexDatabase).mockReturnValue(index.db)
    queue = new SyncQueueManager(asSyncDb(data.db))
    data.db
      .insert(syncDevices)
      .values({
        id: 'device-1',
        name: 'This device',
        platform: 'win32',
        appVersion: '2026.11.21',
        linkedAt: new Date(),
        isCurrentDevice: true,
        signingPublicKey: 'pk'
      })
      .run()
    // A note embeds the pasted image; the image is a note too. The photo is
    // a binary note of the user's own, outside the attachment store.
    note('host', 'notes/host.md', 'markdown')
    note('stray', STRAY, 'image')
    note('photo', 'notes/photo.png', 'image')
  })

  afterEach(() => {
    resetNoteSyncService()
    vi.restoreAllMocks()
    index.close()
    data.close()
    fs.rmSync(vaultPath, { recursive: true, force: true })
  })

  function note(id: string, relativePath: string, fileType: 'markdown' | 'image'): void {
    upsertNoteMetadata(asClientDb(data.db), {
      id,
      path: relativePath,
      title: path.basename(relativePath, path.extname(relativePath)),
      fileType,
      ...(fileType === 'image' ? { attachmentId: `att-${id}` } : {}),
      clock: { windows: 2 },
      createdAt: '2026-01-10T00:00:00.000Z',
      modifiedAt: '2026-01-12T00:00:00.000Z',
      syncedAt: '2026-01-12T00:00:00.000Z'
    })
    const absolutePath = path.join(vaultPath, relativePath)
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true })
    fs.writeFileSync(absolutePath, id)
  }

  const queued = (): string[] =>
    queue
      .peek(20)
      .map((row) => `${row.type}:${row.itemId}:${row.operation}`)
      .toSorted()

  it('pushes no record of it', async () => {
    for (const id of ['stray', 'photo']) {
      queue.enqueue({
        type: 'note',
        itemId: id,
        operation: 'update',
        payload: JSON.stringify({ fileType: 'image', clock: { windows: 2 } })
      })
    }
    vi.spyOn(await import('./encrypt'), 'encryptItemForPush').mockImplementation(
      (input: EncryptItemInput) => ({
        pushItem: {
          id: input.id,
          type: input.type,
          operation: input.operation,
          encryptedKey: 'ek',
          keyNonce: 'kn',
          encryptedData: 'ed',
          dataNonce: 'dn',
          signature: 'sig',
          signerDeviceId: input.signerDeviceId,
          clock: input.clock
        },
        sizeBytes: 100
      })
    )
    const post = vi
      .spyOn(await import('./http-client'), 'postToServer')
      .mockImplementation(async (_path: string, body: unknown) => {
        const { items } = body as { items: { id: string }[] }
        return {
          accepted: items.map((item) => item.id),
          rejected: [],
          serverTime: Math.floor(Date.now() / 1000)
        }
      })

    await new SyncEngine(createMockDeps(data)).push()

    expect(
      post.mock.calls.flatMap(([, body]) =>
        (body as { items: { id: string }[] }).items.map((item) => item.id)
      )
    ).toEqual(['photo'])
    expect(queued()).toEqual([])
  })

  it('pushes no body of it', async () => {
    const doc = new Y.Doc()
    doc.getMap('meta').set('title', 'abc-pasted')
    const update = Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64')
    for (const id of ['stray', 'host']) queue.enqueueNoteBody(id, update)
    const push = vi.fn<NoteBodyPushFn>(async () => {})
    // As the sync runtime wires it.
    const db = asSyncDb(data.db)
    const outbox = new NoteBodyOutbox({
      queue,
      push,
      isBinaryNote: (noteId) => isBinaryNote(db, noteId)
    })

    outbox.start()
    await vi.waitFor(() => expect(queue.countNoteBodyRows()).toBe(0))
    outbox.stop()

    expect(push.mock.calls.map(([noteId]) => noteId)).toEqual(['host'])
  })

  it('uploads no blob of it', async () => {
    for (const [id, relativePath] of [
      ['stray', STRAY],
      ['photo', 'notes/photo.png']
    ]) {
      queueUploadIfAbsent(asSyncDb(data.db), id, path.join(vaultPath, relativePath))
    }
    const upload = vi.fn(async (_noteId: string, _diskPath: string) => ({
      attachmentId: 'att',
      sha256: 'sha'
    }))

    await drainOutboxWith({ db: asSyncDb(data.db), vaultPath, upload })

    expect(upload.mock.calls.map(([noteId]) => noteId)).toEqual(['photo'])
    expect(data.db.select().from(attachmentUploadQueue).all()).toMatchObject([{ noteId: 'stray' }])
  })

  // A peer on an older build unlinks a deleted note's file, and the file is
  // the one the host note embeds.
  it('queues no delete of it, now or deferred, and frees none of its blob', () => {
    const notes = initNoteSyncService({ queue, getDeviceId: () => 'device-1' })

    for (const id of ['stray', 'photo']) {
      notes.enqueueDelete(id)
      recordDeletedItemAssets(asClientDb(data.db), 'note', id)
    }

    expect(queued()).toEqual(['note:photo:delete'])
    expect(buildContentDeletePayload(asClientDb(data.db), 'stray')).toBeNull()
    expect(buildContentDeletePayload(asClientDb(data.db), 'photo')).not.toBeNull()
    expect(
      data.db
        .select({ id: deletedAssetReleases.itemId })
        .from(deletedAssetReleases)
        .all()
        .map((row) => row.id)
    ).toEqual(['photo'])
  })
})
