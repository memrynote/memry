import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import { syncDevices, syncPendingDeletes, syncTombstoneClocks } from '@memry/db-schema/data-schema'
import { getNoteMetadataById, updateNoteMetadata, upsertNoteMetadata } from '@memry/storage-data'

import { openDatabases } from './app-core/database.ts'

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

const cases: Array<{ name: string; device: boolean; setup: Setup; queued: string | null }> = [
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
    // A stray an older Windows build made of a pasted attachment (#5607): its
    // delete would make a peer unlink the file another note embeds.
    name: 'a stray row in the attachment store',
    device: true,
    setup: async (vaultPath) => {
      const id = `note_${randomUUID()}`
      const now = new Date().toISOString()
      withDatabases(vaultPath, ({ dataDb }) =>
        upsertNoteMetadata(dataDb, {
          id,
          path: 'attachments/note_owner/scan.png',
          title: 'scan',
          fileType: 'image',
          createdAt: now,
          modifiedAt: now,
          clock: { [DEVICE]: 2, peer: 7 }
        })
      )
      return id
    },
    queued: null
  }
]

for (const { name, device, setup, queued } of cases) {
  test(`notes delete of ${name} ${queued ? `queues a ${queued} tombstone` : 'queues no tombstone'}`, async () => {
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

    assert.deepEqual(binary(vaultPath, 'notes', 'delete', id, '--yes'), { success: true })

    const after = withDatabases(vaultPath, ({ dataDb }) => ({
      row: getNoteMetadataById(dataDb, id) ?? null,
      pending: dataDb.select().from(syncPendingDeletes).all(),
      tombstones: dataDb.select().from(syncTombstoneClocks).all()
    }))
    assert.equal(after.row, null)
    await assert.rejects(fs.access(path.join(vaultPath, before.path)), { code: 'ENOENT' })

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
