import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { CrdtManifestResponseSchema, type CrdtManifestDocument } from '@memry/contracts/sync-api'
import { SimulatedServer } from '../src/simulated-server.js'
import { SimulatedDevice } from '../src/simulated-device.js'
import { createTestDevice } from '../src/test-auth.js'
import { generateVaultKey, initCrypto } from '../src/crypto.js'
import type { DeviceIdentity } from '../src/types.js'

// #5232: GET /sync/crdt/manifest on the real Worker answers the same floor and
// snapshot revision per document as POST /sync/crdt/updates/batch (protocol 08
// §8.4.3, §8.10), across pages, for a purged document too.

const server = new SimulatedServer()
const fetchFn = (input: RequestInfo | URL, init?: RequestInit) => server.fetch(input, init)

const call = async (identity: DeviceIdentity, path: string, body?: unknown): Promise<unknown> => {
  const res = await server.fetch(`http://localhost${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${identity.accessToken}`
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  })
  if (res.status !== 200) throw new Error(`${path} answered ${res.status}`)
  return res.json()
}

const bytes = (...values: number[]): string => Buffer.from(values).toString('base64')

describe('Sync Harness — CRDT body manifest (#5232)', () => {
  let reader: DeviceIdentity
  const noteUpdates = crypto.randomUUID()
  const noteSnapshot = crypto.randomUUID()
  const notePurged = crypto.randomUUID()

  beforeAll(async () => {
    await initCrypto()
    await server.start()
    await server.truncateTables()

    const vaultKey = generateVaultKey()
    const authorId = await createTestDevice(server, { vaultKey })
    reader = await createTestDevice(server, { userId: authorId.userId, vaultKey })
    const author = new SimulatedDevice(authorId, fetchFn)
    for (const id of [noteUpdates, noteSnapshot, notePurged]) {
      await author.createItem('note', id, { title: 'note' })
    }
    await author.push()

    await call(authorId, '/sync/crdt/updates', {
      noteId: noteUpdates,
      updates: [bytes(1), bytes(2)]
    })
    await call(authorId, '/sync/crdt/snapshot', { noteId: noteSnapshot, snapshot: bytes(9) })
    await call(authorId, '/sync/crdt/updates', { noteId: noteSnapshot, updates: [bytes(3)] })
    await call(authorId, '/sync/crdt/updates', {
      noteId: notePurged,
      updates: [bytes(4), bytes(5), bytes(6)]
    })
    const pushed = await author.push([await author.deleteItem(notePurged)])
    if (pushed.rejected.length > 0) throw new Error('delete push rejected')
  })

  afterAll(async () => {
    await server.stop()
  })

  it('pages every document and matches the batch answer', async () => {
    const documents: CrdtManifestDocument[] = []
    let cursor: string | null = null
    let pages = 0
    do {
      const query: string = cursor === null ? 'limit=2' : `limit=2&cursor=${cursor}`
      const page = CrdtManifestResponseSchema.parse(
        await call(reader, `/sync/crdt/manifest?${query}`)
      )
      documents.push(...page.documents)
      cursor = page.nextCursor
      pages++
    } while (cursor !== null)

    expect(pages).toBe(2)
    expect(documents.map((d) => d.noteId)).toEqual(
      [noteUpdates, noteSnapshot, notePurged].toSorted()
    )

    const batch = (await call(reader, '/sync/crdt/updates/batch', {
      notes: documents.map((d) => ({ noteId: d.noteId, since: 0 }))
    })) as {
      notes: Record<string, { floor: number }>
      snapshotMeta: Record<string, { revision: string; sequenceNum: number }>
    }
    for (const document of documents) {
      expect(document.floor).toBe(batch.notes[document.noteId].floor)
      expect(document.snapshot).toEqual(
        batch.snapshotMeta[document.noteId]
          ? {
              revision: batch.snapshotMeta[document.noteId].revision,
              sequenceNum: batch.snapshotMeta[document.noteId].sequenceNum
            }
          : null
      )
    }

    const byId = new Map(documents.map((d) => [d.noteId, d]))
    expect(byId.get(noteUpdates)).toMatchObject({ floor: 0, snapshot: null, maxSequenceNum: 2 })
    expect(byId.get(noteSnapshot)).toMatchObject({ floor: 0, maxSequenceNum: 1 })
    expect(byId.get(notePurged)).toEqual({
      noteId: notePurged,
      floor: 3,
      snapshot: null,
      maxSequenceNum: 0
    })
  })
})
