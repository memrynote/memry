import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import {
  RECORD_SYNC_ITEM_TYPES,
  RecordChangesResponseSchema,
  type RecordChangesResponse
} from '@memry/contracts/sync-api'
import { SimulatedServer } from '../src/simulated-server.js'
import { SimulatedDevice } from '../src/simulated-device.js'
import { createTestDevice } from '../src/test-auth.js'
import { generateVaultKey, initCrypto } from '../src/crypto.js'
import type { DeviceIdentity } from '../src/types.js'

// #2295: the real Worker on Miniflare D1, migrations applied from the ledger.
// A CRDT update and a record push share one cursor sequence, and only a client
// that declares note_body is served the body row.

const server = new SimulatedServer()

const changes = async (
  identity: DeviceIdentity,
  syncTypes: string
): Promise<RecordChangesResponse> => {
  const res = await server.fetch('http://localhost/sync/changes?cursor=0&limit=100', {
    headers: {
      Authorization: `Bearer ${identity.accessToken}`,
      'X-Memry-Sync-Types': syncTypes
    }
  })
  expect(res.status).toBe(200)
  const body: unknown = await res.json()
  return RecordChangesResponseSchema.parse(body)
}

describe('Sync Harness — note bodies in the change feed (#2295)', () => {
  beforeAll(async () => {
    await initCrypto()
    await server.start()
  })

  afterAll(async () => {
    await server.stop()
  })

  beforeEach(async () => {
    await server.truncateTables()
  })

  it('serves a CRDT update and a record in one cursor order only to a note_body subscriber', async () => {
    const identity = await createTestDevice(server, { vaultKey: generateVaultKey() })
    const device = new SimulatedDevice(identity, (input, init) => server.fetch(input, init))

    const update = new Uint8Array([7, 7, 7, 7])
    const updateRes = await server.fetch('http://localhost/sync/crdt/updates', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${identity.accessToken}`
      },
      body: JSON.stringify({
        noteId: 'note-live-1',
        updates: [Buffer.from(update).toString('base64')]
      })
    })
    expect(updateRes.status).toBe(200)
    expect(await updateRes.json()).toEqual({ sequences: [1] })

    const taskId = crypto.randomUUID()
    await device.createItem('task', taskId, { title: 'live feed' })
    const pushed = await device.push()
    expect(pushed.accepted).toEqual([taskId])

    const withBodies = await changes(identity, [...RECORD_SYNC_ITEM_TYPES, 'note_body'].join(','))
    console.log('[#2295 live] with note_body:', JSON.stringify(withBodies))
    expect(withBodies.noteBodies).toEqual([
      {
        op: 'update',
        noteId: 'note-live-1',
        cursor: 1,
        sequenceNum: 1,
        signerDeviceId: identity.deviceId,
        createdAt: expect.any(Number),
        size: 4,
        data: Buffer.from(update).toString('base64')
      }
    ])
    expect(withBodies.items.map((item) => [item.id, item.serverCursor])).toEqual([[taskId, 2]])
    expect(withBodies.nextCursor).toBe(2)
    expect(withBodies.hasMore).toBe(false)

    const recordsOnly = await changes(identity, RECORD_SYNC_ITEM_TYPES.join(','))
    console.log('[#2295 live] without note_body:', JSON.stringify(recordsOnly))
    expect(recordsOnly).not.toHaveProperty('noteBodies')
    expect(recordsOnly.items.map((item) => [item.id, item.serverCursor])).toEqual([[taskId, 2]])
    expect(recordsOnly.nextCursor).toBe(2)

    const db = await server.getD1()
    const cursorRow = await db
      .prepare('SELECT server_cursor FROM crdt_updates WHERE note_id = ?')
      .bind('note-live-1')
      .first<{ server_cursor: number }>()
    expect(cursorRow?.server_cursor).toBe(1)
  })
})
