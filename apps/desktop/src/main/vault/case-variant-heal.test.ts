/**
 * Vault open drops the copies an earlier case-only folder rename indexed under
 * the old spelling, and keeps every file and every note the disk spells.
 *
 * @module vault/case-variant-heal.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { noteCache } from '@memry/db-schema/schema/notes-cache'
import { noteMetadata } from '@memry/db-schema/schema/note-metadata'
import { folderConfigs } from '@memry/db-schema/schema/folder-configs'
import { createTestVault } from '@tests/utils/test-vault'
import {
  asClientDb,
  createTestDataDb,
  createTestIndexDb,
  type TestDatabaseResult
} from '@tests/utils/test-db'
import { insertNoteCache } from '@main/database/queries/notes'
import { syncQueue } from '@memry/db-schema/schema/sync-queue'
import { crdtOwedFileBodies } from '@memry/db-schema/schema/crdt-owed-file-bodies'
import { noteBodySync } from '@memry/db-schema/schema/note-body-sync'
import { eq } from 'drizzle-orm'
import { NOTE_BODY_QUEUE_TYPE } from '@memry/sync-client/queue'
import { CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'
import { LeveldbPersistence } from 'y-leveldb'
import type { CrdtPersistence } from '../sync/crdt-persistence'
import * as Y from 'yjs'

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: vi.fn(() => []) } }))
// The provider's doc store is the real LevelDB adapter; only the provider's
// vault-scoped init (preflight child, store path) is left out.
const crdt = vi.hoisted(() => ({ store: null as CrdtPersistence | null }))
vi.mock('../sync/crdt-provider', async () => {
  const { readOnlyStore } = await import('../sync/crdt-persistence')
  return {
    getCrdtProvider: () => ({
      awaitPendingInit: async () => {},
      hasPersistence: () => crdt.store !== null,
      getDoc: () => undefined,
      readOnlyStore: () => (crdt.store ? readOnlyStore(crdt.store) : null)
    })
  }
})
vi.mock('../database', () => ({
  getIndexDatabase: vi.fn(),
  getDatabase: vi.fn(),
  updateFtsContent: vi.fn()
}))

import { getDatabase, getIndexDatabase } from '../database'
import { createNoteDerivedStateProjector } from '../projections/projectors/note-derived-state-projector'
import { startProjectionRuntime, stopProjectionRuntime } from '../projections'
import { healCaseVariantRows } from './case-variant-heal'
import { markdownToYFragment } from '../sync/blocknote-converter'
import { folderConfigHandler } from '../sync/item-handlers/folder-config-handler'
import { isSupersededByLiveRow, recordPendingDelete } from '../sync/pending-deletes'
import type { SyncQueueManager } from '@memry/sync-client/queue'

function fileSystemIgnoresCase(): boolean {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-case-probe-'))
  try {
    fs.writeFileSync(path.join(dir, 'probe'), '')
    return fs.existsSync(path.join(dir, 'PROBE'))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

describe('healCaseVariantRows', () => {
  let vault: ReturnType<typeof createTestVault>
  let data: TestDatabaseResult
  let index: TestDatabaseResult
  let crdtDir: string

  beforeEach(() => {
    vault = createTestVault('case-heal')
    data = createTestDataDb()
    index = createTestIndexDb()
    vi.mocked(getDatabase).mockReturnValue(asClientDb(data.db))
    vi.mocked(getIndexDatabase).mockReturnValue(index.db)
    crdtDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-case-heal-crdt-'))
    crdt.store = new LeveldbPersistence(crdtDir)
    startProjectionRuntime([createNoteDerivedStateProjector(() => vault.path)])
  })

  afterEach(async () => {
    await stopProjectionRuntime({ drain: true })
    await crdt.store?.destroy()
    crdt.store = null
    fs.rmSync(crdtDir, { recursive: true, force: true })
    index.close()
    data.close()
    vault.cleanup()
  })

  function writeFile(relativePath: string, body: string): void {
    const absolutePath = path.join(vault.path, relativePath)
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true })
    fs.writeFileSync(absolutePath, body)
  }

  function seedRows(
    id: string,
    relativePath: string,
    options: { contentHash?: string; synced?: boolean } = {}
  ): void {
    const fields = {
      id,
      path: relativePath,
      title: path.basename(relativePath, '.md'),
      fileType: 'markdown' as const,
      createdAt: '2026-01-10T00:00:00.000Z',
      modifiedAt: '2026-01-12T00:00:00.000Z',
      syncedAt: options.synced ? '2026-01-12T00:00:00.000Z' : null
    }
    insertNoteCache(index.db, {
      ...fields,
      fileSize: 4,
      contentHash: options.contentHash ?? `hash-${id}`
    })
    data.db.insert(noteMetadata).values(fields).run()
  }

  function seedFolder(folderPath: string, icon: string | null, synced = false): void {
    data.db
      .insert(folderConfigs)
      .values({
        path: folderPath,
        icon,
        clock: synced ? { peer: 1 } : null,
        createdAt: 'x',
        modifiedAt: 'x'
      })
      .run()
  }

  const notes = () => ({
    canonical: data.db
      .select({ id: noteMetadata.id, path: noteMetadata.path })
      .from(noteMetadata)
      .all()
      .toSorted((a, b) => a.id.localeCompare(b.id)),
    index: index.db
      .select({ id: noteCache.id, path: noteCache.path })
      .from(noteCache)
      .all()
      .toSorted((a, b) => a.id.localeCompare(b.id))
  })
  const folders = () =>
    data.db
      .select({ path: folderConfigs.path, icon: folderConfigs.icon })
      .from(folderConfigs)
      .all()
      .toSorted((a, b) => a.path.localeCompare(b.path))

  it.runIf(fileSystemIgnoresCase())(
    'drops the old-case copies of renamed notes and folders, keeping the files',
    async () => {
      writeFile('SuperNotes/Sub/a.md', 'body')
      // The old watcher indexed the one file again: the copy has its body.
      seedRows('original', 'SuperNotes/Sub/a.md', { contentHash: 'hash-body' })
      seedRows('copy', 'Supernotes/Sub/a.md', { contentHash: 'hash-body' })
      // The disk has the old spelling here, and no row has the new one.
      writeFile('Other/b.md', 'kept')
      seedRows('lone', 'other/b.md')
      seedFolder('SuperNotes', 'star')
      seedFolder('SuperNotes/Sub', null)
      seedFolder('Supernotes/Sub', null)

      expect(await healCaseVariantRows(vault.path)).toEqual({ notes: 1, folders: 1 })

      const kept = [
        { id: 'lone', path: 'other/b.md' },
        { id: 'original', path: 'SuperNotes/Sub/a.md' }
      ]
      expect(notes()).toEqual({ canonical: kept, index: kept })
      expect(folders()).toEqual([
        { path: 'SuperNotes', icon: 'star' },
        { path: 'SuperNotes/Sub', icon: null }
      ])
      expect(fs.readFileSync(path.join(vault.path, 'SuperNotes/Sub/a.md'), 'utf8')).toBe('body')
      expect(fs.readFileSync(path.join(vault.path, 'Other/b.md'), 'utf8')).toBe('kept')
    }
  )

  // A copy is the kept note's body indexed again, pushed or not. A row with its
  // own body is a distinct note, whether it ever synced or not (#5297).
  it.runIf(fileSystemIgnoresCase())(
    'drops a synced copy of the same body and keeps case twins, synced or not',
    async () => {
      writeFile('SuperNotes/a.md', 'body')
      seedRows('original', 'SuperNotes/a.md', { contentHash: 'hash-body', synced: true })
      seedRows('copy', 'Supernotes/a.md', { contentHash: 'hash-body', synced: true })
      seedRows('twin', 'SUPERNOTES/a.md', { contentHash: 'hash-twin', synced: true })
      seedRows('local-twin', 'supernotes/A.md', { contentHash: 'hash-local' })

      expect(await healCaseVariantRows(vault.path)).toEqual({ notes: 1, folders: 0 })
      expect(notes().canonical.map((row) => row.id)).toEqual(['local-twin', 'original', 'twin'])
    }
  )

  // The index hash says only what the file held when indexed. A row with a
  // change the server has not taken may hold text or fields the kept note
  // lacks, so it stays until that change is sent (#5247 C37.1).
  const queueRow = (type: string) => () =>
    data.db
      .insert(syncQueue)
      .values({
        id: `queued-${type}`,
        type,
        itemId: 'copy',
        operation: 'update',
        payload: '{}',
        createdAt: new Date('2026-01-12T00:00:00.000Z')
      })
      .run()
  it.runIf(fileSystemIgnoresCase()).each([
    { waiting: 'a queued body change', seed: queueRow(NOTE_BODY_QUEUE_TYPE) },
    { waiting: 'a queued record change', seed: queueRow('note') },
    {
      waiting: 'a file body its doc has not taken',
      seed: () => data.db.insert(crdtOwedFileBodies).values({ noteId: 'copy', createdAt: 1 }).run()
    },
    {
      waiting: 'a refused body push',
      seed: () =>
        data.db
          .insert(noteBodySync)
          .values({ noteId: 'copy', lastRejectedAt: 2, updatedAt: 2 })
          .run()
    },
    {
      waiting: 'a saved record change not yet queued',
      seed: () =>
        data.db
          .update(noteMetadata)
          .set({ clock: { peer: 1 }, syncedAt: '2026-01-11T00:00:00.000Z' })
          .where(eq(noteMetadata.id, 'copy'))
          .run()
    }
  ])('keeps a same-hash copy with $waiting', async ({ seed }) => {
    writeFile('SuperNotes/a.md', 'body')
    seedRows('original', 'SuperNotes/a.md', { contentHash: 'hash-body' })
    seedRows('copy', 'Supernotes/a.md', { contentHash: 'hash-body' })
    seed()

    expect(await healCaseVariantRows(vault.path)).toEqual({ notes: 0, folders: 0 })
    expect(notes().canonical.map((row) => row.id)).toEqual(['copy', 'original'])
  })

  /** The doc an editor saved for `noteId`: the store holds it, no file does. */
  async function saveDoc(noteId: string, markdown: string): Promise<void> {
    const doc = new Y.Doc()
    await markdownToYFragment(markdown, doc.getXmlFragment(CRDT_FRAGMENT_NAME))
    await crdt.store?.storeUpdate(noteId, Y.encodeStateAsUpdate(doc))
    doc.destroy()
  }

  // Sync off queues nothing, so only the saved doc shows text the copy holds
  // and the shared file lacks, such as an edit not yet written back at quit.
  // A doc seeded from the same file as the kept note's holds nothing more.
  it.runIf(fileSystemIgnoresCase())(
    'keeps a same-hash copy whose saved doc holds text the kept note lacks',
    async () => {
      writeFile('SuperNotes/a.md', 'body')
      seedRows('original', 'SuperNotes/a.md', { contentHash: 'hash-body' })
      seedRows('copy', 'Supernotes/a.md', { contentHash: 'hash-body' })
      seedRows('seeded', 'superNotes/a.md', { contentHash: 'hash-body' })
      await saveDoc('original', 'body\n')
      await saveDoc('seeded', 'body\n')
      await saveDoc('copy', 'body\n\nwords typed before quit\n')

      expect(await healCaseVariantRows(vault.path)).toEqual({ notes: 1, folders: 0 })
      expect(notes().canonical.map((row) => row.id)).toEqual(['copy', 'original'])
    }
  )

  it.runIf(fileSystemIgnoresCase())(
    'keeps every note copy while no doc store is open',
    async () => {
      writeFile('SuperNotes/a.md', 'body')
      seedRows('original', 'SuperNotes/a.md', { contentHash: 'hash-body' })
      seedRows('copy', 'Supernotes/a.md', { contentHash: 'hash-body' })
      await crdt.store?.destroy()
      crdt.store = null

      expect(await healCaseVariantRows(vault.path)).toEqual({ notes: 0, folders: 0 })
    }
  )

  // A folder row with a clock can be a server record, and a dropped one comes
  // back by the next manifest check only to be dropped again (#5327). An
  // unsynced row with the kept row's icon holds nothing, so it still goes.
  it.runIf(fileSystemIgnoresCase())(
    'drops only an unsynced folder copy with the kept icon, keeping folder twins',
    async () => {
      fs.mkdirSync(path.join(vault.path, 'SuperNotes'))
      seedFolder('SuperNotes', 'star', true)
      seedFolder('Supernotes', 'star', true)
      seedFolder('SUPERNOTES', 'moon')
      seedFolder('supernotes', 'star')

      expect(await healCaseVariantRows(vault.path)).toEqual({ notes: 0, folders: 1 })
      expect(new Set(folders().map((row) => row.path))).toEqual(
        new Set(['SUPERNOTES', 'SuperNotes', 'Supernotes'])
      )
    }
  )

  // A rename of an iconed folder while signed out re-keys its row and records a
  // pending delete of the old spelling; the old watcher then wrote the old
  // spelling back with a null icon. That row holds nothing, and kept, it would
  // retire the delete and push a new server twin.
  it.runIf(fileSystemIgnoresCase())(
    'drops the null-icon row an old watcher wrote after a signed-out rename',
    async () => {
      fs.mkdirSync(path.join(vault.path, 'SuperNotes'))
      seedFolder('SuperNotes', 'star')
      seedFolder('Supernotes', null)
      recordPendingDelete(asClientDb(data.db), 'folder_config', 'Supernotes', '{}')

      expect(await healCaseVariantRows(vault.path)).toEqual({ notes: 0, folders: 1 })

      expect(isSupersededByLiveRow(asClientDb(data.db), 'folder_config', 'Supernotes')).toBe(false)
      const pushed: string[] = []
      const queue = { enqueue: (item: { itemId: string }) => pushed.push(item.itemId) }
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- seedUnclocked only calls enqueue
      folderConfigHandler.seedUnclocked(
        asClientDb(data.db),
        'device-1',
        queue as unknown as SyncQueueManager
      )
      expect(pushed).toEqual(['SuperNotes'])
    }
  )

  it.runIf(!fileSystemIgnoresCase())(
    'keeps paths that differ only in case when each is its own file',
    async () => {
      writeFile('SuperNotes/a.md', 'one')
      writeFile('Supernotes/a.md', 'two')
      seedRows('upper', 'SuperNotes/a.md')
      seedRows('lower', 'Supernotes/a.md')
      seedFolder('SuperNotes', null)
      seedFolder('Supernotes', null)

      expect(await healCaseVariantRows(vault.path)).toEqual({ notes: 0, folders: 0 })

      const kept = [
        { id: 'lower', path: 'Supernotes/a.md' },
        { id: 'upper', path: 'SuperNotes/a.md' }
      ]
      expect(notes()).toEqual({ canonical: kept, index: kept })
      expect(
        folders()
          .map((row) => row.path)
          .toSorted()
      ).toEqual(['SuperNotes', 'Supernotes'])
    }
  )
})
