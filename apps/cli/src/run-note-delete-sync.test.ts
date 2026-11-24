import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import {
  deletedAssetReleases,
  syncDevices,
  syncPendingDeletes,
  syncTombstoneClocks
} from '@memry/db-schema/data-schema'
import { getNoteMetadataById, updateNoteMetadata, upsertNoteMetadata } from '@memry/storage-data'

import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as dataSchema from '@memry/db-schema/data-schema'

import { openDatabases } from './app-core/database.ts'
import { deleteNoteRowQueuingSyncDelete } from './app-core/note-sync-delete.ts'

const testRoot = path.join(process.cwd(), 'test-results', 'memry-cli-note-delete-sync')
await fs.mkdir(testRoot, { recursive: true })

const DEVICE = 'device-this'

/** The shipped `memrynote` binary, run as a user runs it. */
function binary(vaultPath: string, ...args: string[]) {
  const result = spawnSync(
    process.execPath,
    [path.join(process.cwd(), 'bin/memrynote.mjs'), '--vault', vaultPath, '--json', ...args],
    { encoding: 'utf8' }
  )
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout) as Record<string, unknown>
}

function withDatabases<T>(vaultPath: string, fn: (db: ReturnType<typeof openDatabases>) => T): T {
  const databases = openDatabases(vaultPath)
  try {
    return fn(databases)
  } finally {
    databases.close()
  }
}

type Setup = (vaultPath: string) => Promise<string>

/** A note created by the CLI, then given the clock a push to the server leaves on it. */
const syncedNote =
  (changes: { localOnly?: boolean } = {}): Setup =>
  async (vaultPath) => {
    const { id } = binary(vaultPath, 'notes', 'create', 'Plan', '--content', 'body') as {
      id: string
    }
    withDatabases(vaultPath, ({ dataDb }) =>
      updateNoteMetadata(dataDb, id, { clock: { [DEVICE]: 2, peer: 7 }, ...changes })
    )
    return id
  }

const cases: Array<{
  name: string
  device: boolean
  setup: Setup
  queued: string | null
  keepsFile?: true
}> = [
  { name: 'a synced note', device: true, setup: syncedNote(), queued: 'note' },
  {
    name: 'a synced journal day',
    device: true,
    setup: async (vaultPath) => {
      const { id } = binary(vaultPath, 'journal', 'write', '2026-03-04', 'day') as { id: string }
      withDatabases(vaultPath, ({ dataDb }) =>
        updateNoteMetadata(dataDb, id, { clock: { [DEVICE]: 2, peer: 7 } })
      )
      return id
    },
    queued: 'journal'
  },
  {
    name: 'a note the server never saw',
    device: true,
    setup: async (vaultPath) =>
      (binary(vaultPath, 'notes', 'create', 'Draft', '--content', 'body') as { id: string }).id,
    queued: null
  },
  { name: 'a local-only note', device: true, setup: syncedNote({ localOnly: true }), queued: null },
  {
    name: 'a synced note on a signed-out device',
    device: false,
    setup: syncedNote(),
    queued: null
  },
  {
    // A stray an older Windows build made of a pasted attachment (#5607). Its
    // file is the one the owner note embeds, so the delete keeps it, and its
    // tombstone would make a peer unlink it.
    name: 'a stray row in the attachment store',
    device: true,
    setup: async (vaultPath) => {
      const owner = binary(vaultPath, 'notes', 'create', 'Owner', '--content', 'scan:') as {
        id: string
      }
      const source = path.join(testRoot, `scan-${randomUUID()}.png`)
      await fs.writeFile(source, 'png bytes')
      const attached = binary(vaultPath, 'notes', 'attach', owner.id, source) as { path: string }
      const id = `note_${randomUUID()}`
      const now = new Date().toISOString()
      withDatabases(vaultPath, ({ dataDb }) =>
        upsertNoteMetadata(dataDb, {
          id,
          path: attached.path,
          title: 'scan',
          fileType: 'image',
          createdAt: now,
          modifiedAt: now,
          clock: { [DEVICE]: 2, peer: 7 }
        })
      )
      return id
    },
    queued: null,
    keepsFile: true
  }
]

for (const { name, device, setup, queued, keepsFile } of cases) {
  const outcome = `${queued ? `queues a ${queued} tombstone` : 'queues no tombstone'}${keepsFile ? ' and keeps the file' : ''}`
  test(`notes delete of ${name} ${outcome}`, async () => {
    const vaultPath = path.join(testRoot, `vault-${process.pid}-${randomUUID()}`)
    await fs.mkdir(vaultPath)
    if (device) {
      withDatabases(vaultPath, ({ dataDb }) =>
        dataDb
          .insert(syncDevices)
          .values({
            id: DEVICE,
            name: 'This Mac',
            platform: 'macos',
            appVersion: '1.0.0',
            linkedAt: new Date(),
            isCurrentDevice: true,
            signingPublicKey: 'key'
          })
          .run()
      )
    }
    const id = await setup(vaultPath)
    const before = withDatabases(vaultPath, ({ dataDb }) => getNoteMetadataById(dataDb, id))
    assert.ok(before)
    const bytes = await fs.readFile(path.join(vaultPath, before.path))

    assert.deepEqual(binary(vaultPath, 'notes', 'delete', id, '--yes'), { success: true })

    const after = withDatabases(vaultPath, ({ dataDb }) => ({
      row: getNoteMetadataById(dataDb, id) ?? null,
      pending: dataDb.select().from(syncPendingDeletes).all(),
      tombstones: dataDb.select().from(syncTombstoneClocks).all()
    }))
    assert.equal(after.row, null)
    const file = path.join(vaultPath, before.path)
    if (keepsFile) assert.deepEqual(await fs.readFile(file), bytes)
    else await assert.rejects(fs.access(file), { code: 'ENOENT' })

    if (!queued) {
      assert.deepEqual(after.pending, [])
      assert.deepEqual(after.tombstones, [])
      return
    }
    // The body desktop's `buildContentDeletePayload` captures: the row's clock
    // ticked once under this device, and no user-visible text.
    const deleteClock = { [DEVICE]: 3, peer: 7 }
    assert.deepEqual(
      after.pending.map(({ type, itemId, payload }) => ({
        type,
        itemId,
        payload: JSON.parse(payload) as unknown
      })),
      [
        {
          type: queued,
          itemId: id,
          payload: {
            clock: deleteClock,
            createdAt: before.createdAt,
            modifiedAt: before.modifiedAt
          }
        }
      ]
    )
    assert.deepEqual(
      after.tombstones.map(({ type, itemId, clock }) => ({ type, itemId, clock })),
      [{ type: 'note', itemId: id, clock: deleteClock }]
    )
  })
}

// A write desktop commits between the delete's read of the row and its first
// write would leave a deferred transaction on a stale snapshot: SQLite refuses
// that write at once (SQLITE_BUSY_SNAPSHOT), whatever the busy timeout.
test('notes delete commits while desktop writes the database mid-delete', async () => {
  const vaultPath = path.join(testRoot, `vault-${process.pid}-${randomUUID()}`)
  await fs.mkdir(vaultPath)
  withDatabases(vaultPath, ({ dataDb }) =>
    dataDb
      .insert(syncDevices)
      .values({
        id: DEVICE,
        name: 'This Mac',
        platform: 'macos',
        appVersion: '1.0.0',
        linkedAt: new Date(),
        isCurrentDevice: true,
        signingPublicKey: 'key'
      })
      .run()
  )
  const id = await syncedNote()(vaultPath)
  const other = await syncedNote()(vaultPath)

  const cli = openDatabases(vaultPath)
  const desktop = openDatabases(vaultPath)
  // Refused at once rather than after the 5 s timeout while the CLI holds the lock.
  desktop.dataSqlite.pragma('busy_timeout = 0')
  const desktopWrite = () => {
    try {
      desktop.dataSqlite
        .prepare('UPDATE note_metadata SET title = ? WHERE id = ?')
        .run('Renamed', other)
    } catch {
      // A real desktop waits for the lock; here it gives up.
    }
  }
  const dataDb = drizzle(cli.dataSqlite, {
    schema: dataSchema,
    logger: {
      logQuery: (query) => {
        if (query.startsWith('insert into "sync_pending_deletes"')) desktopWrite()
      }
    }
  })
  try {
    deleteNoteRowQueuingSyncDelete(dataDb, id)

    assert.equal(getNoteMetadataById(cli.dataDb, id), undefined)
    assert.deepEqual(
      cli.dataDb.select({ itemId: syncPendingDeletes.itemId }).from(syncPendingDeletes).all(),
      [{ itemId: id }]
    )
  } finally {
    cli.close()
    desktop.close()
  }
})

// Desktop's delete records the note's attachments so its release runner frees
// them on the server after the grace period (`recordLocalItemDelete`). The
// watcher's unlink after a CLI delete finds no row to read them from (#5693).
test('notes delete records the note attachments for release', async () => {
  const vaultPath = path.join(testRoot, `vault-${process.pid}-${randomUUID()}`)
  await fs.mkdir(vaultPath)
  const { id } = binary(vaultPath, 'notes', 'create', 'Scans', '--content', 'body') as {
    id: string
  }
  withDatabases(vaultPath, ({ dataDb }) =>
    updateNoteMetadata(dataDb, id, { attachmentReferences: ['att-1', 'att-2'] })
  )
  const before = Date.now()

  assert.deepEqual(binary(vaultPath, 'notes', 'delete', id, '--yes'), { success: true })

  const releases = withDatabases(vaultPath, ({ dataDb }) =>
    dataDb.select().from(deletedAssetReleases).all()
  )
  assert.deepEqual(
    releases.map(({ itemType, itemId, attachmentIds }) => ({ itemType, itemId, attachmentIds })),
    [{ itemType: 'note', itemId: id, attachmentIds: ['att-1', 'att-2'] }]
  )
  assert.ok(releases[0].deletedAt >= before)
})
