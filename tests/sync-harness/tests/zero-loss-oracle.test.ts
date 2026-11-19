import { createHash } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { SimulatedServer } from '../src/simulated-server.js'
import { SimulatedDevice } from '../src/simulated-device.js'
import { createTestDevice } from '../src/test-auth.js'
import { generateVaultKey, initCrypto } from '../src/crypto.js'
import type { DeviceIdentity } from '../src/types.js'
import {
  checkSemantic,
  checkStructural,
  fetchServerTruth,
  formatFindings,
  type DeviceDigests,
  type Finding,
  type LocalVaultState,
  type ServerVaultTruth
} from '../src/zero-loss-oracle/index.js'

// #5225: the oracle is green on a device that bootstrapped the real Worker item
// by item, and each fault class turns it red naming the item. Every fault is
// built from that device's real state, not from hand-written fixtures.

const server = new SimulatedServer()
const fetchFn = (input: RequestInfo | URL, init?: RequestInit) => server.fetch(input, init)

const noteA = crypto.randomUUID() // three updates
const noteB = crypto.randomUUID() // snapshot, then one update
const noteEmpty = crypto.randomUUID() // no body on the server
const noteDeleted = crypto.randomUUID()
const task = crypto.randomUUID()

let truth: ServerVaultTruth
/** The reference device before the author's second round: older task, live noteDeleted. */
let before: LocalVaultState
let after: LocalVaultState
let authorDigests: DeviceDigests
let readerDigests: DeviceDigests
let readerDigestsBefore: DeviceDigests

const post = async (identity: DeviceIdentity, path: string, body: unknown): Promise<void> => {
  const res = await server.fetch(`http://localhost${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${identity.accessToken}`
    },
    body: JSON.stringify(body)
  })
  expect(res.status).toBe(200)
}

const bytes = (...values: number[]): string => Buffer.from(values).toString('base64')

/** Harness stand-in for the §12.11 digest: SHA-256 of each live item's content. */
const digestsOf = (label: string, device: SimulatedDevice): DeviceDigests => {
  const digests: Record<string, string> = {}
  for (const item of device.getAllItems().values()) {
    if (item.operation === 'delete') continue
    digests[item.id] = createHash('sha256').update(JSON.stringify(item.content)).digest('hex')
  }
  return { label, digests }
}

const expectRed = (findings: Finding[], kind: Finding['kind'], itemId: string): void => {
  console.log(`[#5225 ${kind}]\n${formatFindings(findings)}`)
  expect(findings.map((f) => [f.kind, f.itemId])).toEqual([[kind, itemId]])
}

describe('Sync Harness — zero-loss oracle (#5225)', () => {
  beforeAll(async () => {
    await initCrypto()
    await server.start()
    await server.truncateTables()

    const vaultKey = generateVaultKey()
    const authorId = await createTestDevice(server, { vaultKey })
    const readerId = await createTestDevice(server, { userId: authorId.userId, vaultKey })
    const author = new SimulatedDevice(authorId, fetchFn)
    const reader = new SimulatedDevice(readerId, fetchFn)
    reader.registerPeerDevice(authorId.deviceId, authorId.signingPublicKey)

    for (const id of [noteA, noteB, noteEmpty, noteDeleted]) {
      await author.createItem('note', id, { title: `note ${id.slice(0, 8)}` })
    }
    await author.createItem('task', task, { title: 'first' })
    const created = await author.push()
    if (created.rejected.length > 0)
      throw new Error(`seed push rejected ${created.rejected.length}`)

    await post(authorId, '/sync/crdt/updates', {
      noteId: noteA,
      updates: [bytes(1), bytes(2), bytes(3)]
    })
    await post(authorId, '/sync/crdt/snapshot', { noteId: noteB, snapshot: bytes(9, 9) })
    await post(authorId, '/sync/crdt/updates', { noteId: noteB, updates: [bytes(4)] })
    await post(authorId, '/sync/crdt/updates', { noteId: noteDeleted, updates: [bytes(5)] })

    await reader.pull()
    await reader.pullBodies([noteA, noteB, noteEmpty, noteDeleted])
    before = reader.oracleState()
    readerDigestsBefore = digestsOf('reader', reader)

    await author.updateItem(task, { title: 'second' })
    const tombstone = await author.deleteItem(noteDeleted)
    const pushed = await author.push([author.getItem(task)!, tombstone])
    if (pushed.rejected.length > 0)
      throw new Error(`second push rejected ${pushed.rejected.length}`)

    await reader.pull()
    await reader.pullBodies([noteA, noteB, noteEmpty])
    after = reader.oracleState()

    truth = await fetchServerTruth({
      baseUrl: 'http://localhost',
      accessToken: readerId.accessToken,
      fetch: fetchFn
    })
    authorDigests = digestsOf('author', author)
    readerDigests = digestsOf('reader', reader)
  })

  afterAll(async () => {
    await server.stop()
  })

  it('reads the vault from the real Worker', () => {
    expect(new Set(Object.keys(truth.records))).toEqual(new Set([noteA, noteB, noteEmpty, task]))
    expect(truth.deleted).toEqual([noteDeleted])
    expect(truth.bodies[noteA]).toEqual({ snapshot: null, updateSequences: [1, 2, 3] })
    expect(truth.bodies[noteB].snapshot?.sequenceNum).toBe(0)
    expect(truth.bodies[noteB].updateSequences).toEqual([1])
    expect(truth.bodies[noteEmpty]).toEqual({ snapshot: null, updateSequences: [] })
  })

  // RCA-5225 rules, pinned here: noteEmpty is a manifest note with no body row,
  // expected-empty, and noteDeleted holds body rows on the server and locally
  // but is absent from the manifest, so neither is a finding.
  it('is green on a device that bootstrapped item by item', () => {
    expect(after.bodies[noteEmpty]).toEqual({ snapshotRevision: null, appliedSequences: [] })
    expect(after.bodies[noteDeleted].appliedSequences).toEqual([1])
    expect(truth.bodies[noteDeleted]).toBeUndefined()
    const structural = checkStructural(truth, after)
    const semantic = checkSemantic(authorDigests, readerDigests)
    console.log(`[#5225 clean]\n${formatFindings([...structural, ...semantic])}`)
    expect(structural).toEqual([])
    expect(semantic).toEqual([])
  })

  it('goes red on a dropped record', () => {
    const local = structuredClone(after)
    delete local.records[task]
    expectRed(checkStructural(truth, local), 'missing_record', task)

    const dropped = structuredClone(readerDigests)
    delete dropped.digests[task]
    expectRed(checkSemantic(authorDigests, dropped), 'digest_missing', task)
  })

  it('goes red on a stale record', () => {
    const local = structuredClone(after)
    local.records[task] = before.records[task]
    expectRed(checkStructural(truth, local), 'stale_record', task)

    const staleContent = structuredClone(readerDigests)
    staleContent.digests[task] = readerDigestsBefore.digests[task]
    expectRed(checkSemantic(authorDigests, staleContent), 'digest_mismatch', task)
  })

  it('goes red on a resurrected deleted note', () => {
    const local = structuredClone(after)
    local.records[noteDeleted] = before.records[noteDeleted]
    expectRed(checkStructural(truth, local), 'resurrected', noteDeleted)
  })

  it('goes red on a truncated body', () => {
    const local = structuredClone(after)
    local.bodies[noteA].appliedSequences.pop()
    expectRed(checkStructural(truth, local), 'body_short', noteA)
  })

  it('goes red on a dropped body', () => {
    const local = structuredClone(after)
    delete local.bodies[noteB]
    expectRed(checkStructural(truth, local), 'body_missing', noteB)
  })

  it('goes red on a body applied twice', () => {
    const local = structuredClone(after)
    local.bodies[noteB].appliedSequences.push(1)
    expectRed(checkStructural(truth, local), 'body_applied_twice', noteB)
  })
})
