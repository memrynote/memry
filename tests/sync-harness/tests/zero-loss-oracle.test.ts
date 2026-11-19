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

// #5225: the oracle is green on devices that bootstrapped the real Worker item
// by item, and each fault class turns it red naming the item. Every fault is
// built from a device's real state, not from hand-written fixtures.

const server = new SimulatedServer()
const fetchFn = (input: RequestInfo | URL, init?: RequestInit) => server.fetch(input, init)

const noteA = crypto.randomUUID() // three updates
const noteB = crypto.randomUUID() // snapshot, then one update
const noteEmpty = crypto.randomUUID() // no body on the server: expected-empty
const noteDeleted = crypto.randomUUID()
const task = crypto.randomUUID()

let readerId: DeviceIdentity
let reader: SimulatedDevice
let truth: ServerVaultTruth
/** The reader before the author's second round: older task, live noteDeleted. */
let before: LocalVaultState
let after: LocalVaultState
let readerDigests: DeviceDigests
let twinDigests: DeviceDigests
let staleTaskDigest: string

const post = async (identity: DeviceIdentity, path: string, body: unknown): Promise<void> => {
  const res = await server.fetch(`http://localhost${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${identity.accessToken}`
    },
    body: JSON.stringify(body)
  })
  if (res.status !== 200) throw new Error(`${path} answered ${res.status}`)
}

const bytes = (...values: number[]): string => Buffer.from(values).toString('base64')

/** Harness stand-in for the §12.11 digest: the record content plus the body's applied payloads. */
const digest = (content: Record<string, unknown>, bodyParts: string[]): string =>
  createHash('sha256')
    .update(`${JSON.stringify(content)}\n${bodyParts.join(',')}`)
    .digest('hex')

const digestsOf = (label: string, device: SimulatedDevice): DeviceDigests => {
  const digests: Record<string, string> = {}
  for (const item of device.getAllItems().values()) {
    if (item.operation === 'delete') continue
    digests[item.id] = digest(item.content, device.getBodyParts(item.id))
  }
  return { label, digests }
}

const expectRed = (findings: Finding[], kind: Finding['kind'], itemId: string): void => {
  console.log(`[#5225 ${kind}]\n${formatFindings(findings)}`)
  expect(findings.map((f) => [f.kind, f.itemId])).toEqual([[kind, itemId]])
}

const urlOf = (input: RequestInfo | URL): string =>
  input instanceof Request ? input.url : input.toString()

/** The batch answer for a note queued behind one that spent the 8 MB byte budget (crdt.ts planUpdatePage). */
const budgetExhaustedOnce = (target: string) => {
  let fired = false
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const res = await fetchFn(input, init)
    if (fired || !urlOf(input).endsWith('/sync/crdt/updates/batch')) return res
    fired = true
    const json = (await res.json()) as { notes: Record<string, unknown> }
    json.notes[target] = { updates: [], hasMore: true }
    return Response.json(json)
  }
}

describe('Sync Harness — zero-loss oracle (#5225)', () => {
  beforeAll(async () => {
    await initCrypto()
    await server.start()
    await server.truncateTables()

    const vaultKey = generateVaultKey()
    const authorId = await createTestDevice(server, { vaultKey })
    readerId = await createTestDevice(server, { userId: authorId.userId, vaultKey })
    const twinId = await createTestDevice(server, { userId: authorId.userId, vaultKey })
    const author = new SimulatedDevice(authorId, fetchFn)
    reader = new SimulatedDevice(readerId, fetchFn)
    const twin = new SimulatedDevice(twinId, fetchFn)
    reader.registerPeerDevice(authorId.deviceId, authorId.signingPublicKey)
    twin.registerPeerDevice(authorId.deviceId, authorId.signingPublicKey)

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
    staleTaskDigest = digestsOf('reader', reader).digests[task]

    await author.updateItem(task, { title: 'second' })
    const tombstone = await author.deleteItem(noteDeleted)
    const pushed = await author.push([author.getItem(task)!, tombstone])
    if (pushed.rejected.length > 0)
      throw new Error(`second push rejected ${pushed.rejected.length}`)

    await reader.pull()
    await reader.pullBodies([noteA, noteB, noteEmpty])
    after = reader.oracleState()
    await twin.pull()
    await twin.pullBodies([noteA, noteB, noteEmpty])

    truth = await fetchServerTruth({
      baseUrl: 'http://localhost',
      accessToken: readerId.accessToken,
      fetch: fetchFn
    })
    readerDigests = digestsOf('reader', reader)
    twinDigests = digestsOf('twin', twin)
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
    expect(truth.bodies[noteDeleted]).toBeUndefined()
  })

  // RCA-5225 rules: noteEmpty is a manifest note with no body row, expected-empty;
  // noteDeleted holds body rows on the server and on the reader but is absent
  // from the manifest, so it is counted and never required.
  it('is green on devices that bootstrapped item by item, and counts the RCA classes', () => {
    expect(after.bodies[noteA]).toEqual({ snapshotRevision: null, appliedThrough: 3, empty: false })
    expect(after.bodies[noteEmpty]).toEqual({
      snapshotRevision: null,
      appliedThrough: 0,
      empty: true
    })
    const { findings, counts } = checkStructural(truth, after)
    const semantic = checkSemantic(readerDigests, twinDigests)
    const report = formatFindings([...findings, ...semantic], counts)
    console.log(`[#5225 clean]\n${report}`)
    expect(findings).toEqual([])
    expect(semantic).toEqual([])
    expect(counts).toEqual({ expected_empty: 1, body_without_record: 1 })
    expect(report).toContain('counts: expected_empty=1 body_without_record=1')
  })

  it('goes red on a dropped record', () => {
    const local = structuredClone(after)
    delete local.records[task]
    expectRed(checkStructural(truth, local).findings, 'missing_record', task)

    const dropped = structuredClone(readerDigests)
    delete dropped.digests[task]
    expectRed(checkSemantic(twinDigests, dropped), 'digest_missing', task)
  })

  it('goes red on a stale record', () => {
    const local = structuredClone(after)
    local.records[task] = before.records[task]
    expectRed(checkStructural(truth, local).findings, 'stale_record', task)

    const stale = structuredClone(readerDigests)
    stale.digests[task] = staleTaskDigest
    expectRed(checkSemantic(twinDigests, stale), 'digest_mismatch', task)
  })

  it('goes red on a resurrected deleted note', () => {
    const local = structuredClone(after)
    local.records[noteDeleted] = before.records[noteDeleted]
    expectRed(checkStructural(truth, local).findings, 'resurrected', noteDeleted)
  })

  it('goes red on a truncated body', () => {
    const local = structuredClone(after)
    local.bodies[noteA].appliedThrough = 2
    expectRed(checkStructural(truth, local).findings, 'body_short', noteA)

    const truncated = structuredClone(readerDigests)
    const content = reader.getItem(noteA)!.content
    truncated.digests[noteA] = digest(content, reader.getBodyParts(noteA).slice(0, -1))
    expectRed(checkSemantic(twinDigests, truncated), 'digest_mismatch', noteA)
  })

  // Clients persist a watermark, not an apply log: a double apply leaves the
  // watermark right, so only the body digest can see it.
  it('goes red on a body applied twice', () => {
    const parts = reader.getBodyParts(noteB)
    const twice = structuredClone(readerDigests)
    twice.digests[noteB] = digest(reader.getItem(noteB)!.content, [...parts, parts.at(-1)!])
    expectRed(checkSemantic(twinDigests, twice), 'digest_mismatch', noteB)
  })

  it('goes red on a dropped body', () => {
    const local = structuredClone(after)
    delete local.bodies[noteB]
    expectRed(checkStructural(truth, local).findings, 'body_missing', noteB)
  })

  it('goes red on content in an expected-empty note', () => {
    const local = structuredClone(after)
    local.bodies[noteEmpty].empty = false
    expectRed(checkStructural(truth, local).findings, 'body_unexpected_content', noteEmpty)
  })

  // VERIFY-5242: an expected-empty note has no body to have applied.
  it('goes red on a watermark or snapshot in an expected-empty note', () => {
    const watermark = structuredClone(after)
    watermark.bodies[noteEmpty].appliedThrough = 2
    expectRed(checkStructural(truth, watermark).findings, 'body_unknown_sequence', noteEmpty)

    const snapshot = structuredClone(after)
    snapshot.bodies[noteEmpty].snapshotRevision = 'rev-1'
    expectRed(checkStructural(truth, snapshot).findings, 'body_unknown_sequence', noteEmpty)
  })

  // VERIFY-5242: a wiped document whose watermark survived still holds no Yjs state.
  it('goes red on an empty body the server holds content for', () => {
    const local = structuredClone(after)
    local.bodies[noteA].empty = true
    expectRed(checkStructural(truth, local).findings, 'body_missing', noteA)
  })

  // REVIEW-5242 probes: a note behind the batch byte budget gets an empty page with hasMore.
  it('keeps every server update when a batch page is empty with hasMore', async () => {
    const budgeted = await fetchServerTruth({
      baseUrl: 'http://localhost',
      accessToken: readerId.accessToken,
      fetch: budgetExhaustedOnce(noteA)
    })
    expect(budgeted.bodies[noteA].updateSequences).toEqual([1, 2, 3])
  })

  it('fails a device body pull that makes no progress instead of storing an empty body', async () => {
    const stuck = new SimulatedDevice(readerId, budgetExhaustedOnce(noteA))
    await expect(stuck.pullBodies([noteA])).rejects.toThrow(
      `body pull for ${noteA} made no progress`
    )
  })

  it('refuses a live server record with no clock', async () => {
    const clockless = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const res = await fetchFn(input, init)
      if (!urlOf(input).endsWith('/sync/pull')) return res
      const json = (await res.json()) as { items: Array<Record<string, unknown>> }
      for (const item of json.items) if (item.id === task) delete item.clock
      return Response.json(json)
    }
    await expect(
      fetchServerTruth({
        baseUrl: 'http://localhost',
        accessToken: readerId.accessToken,
        fetch: clockless
      })
    ).rejects.toThrow(`oracle: live task ${task} has no clock`)
  })

  // VERIFY-5242: settings is not clock-required; desktop pushes it without a
  // top-level clock and rows from before #1223 can be clockless. Runs last: it
  // adds a record to the server.
  it('reads a clockless settings row and still checks its existence and type', async () => {
    const settingsId = crypto.randomUUID()
    await reader.createItem('settings', settingsId, { theme: 'dark' })
    const pushed = await reader.push([reader.getItem(settingsId)!])
    if (pushed.rejected.length > 0) throw new Error('settings push rejected')
    const db = await server.getD1()
    await db.prepare('UPDATE sync_items SET clock = NULL WHERE item_id = ?').bind(settingsId).run()

    const clockless = await fetchServerTruth({
      baseUrl: 'http://localhost',
      accessToken: readerId.accessToken,
      fetch: fetchFn
    })
    expect(clockless.records[settingsId]).toEqual({ type: 'settings', clock: null })
    const local = reader.oracleState()
    expect(checkStructural(clockless, local).findings).toEqual([])

    const missing = structuredClone(local)
    delete missing.records[settingsId]
    expectRed(checkStructural(clockless, missing).findings, 'missing_record', settingsId)

    const retyped = structuredClone(local)
    retyped.records[settingsId].type = 'task'
    expectRed(checkStructural(clockless, retyped).findings, 'type_mismatch', settingsId)
  })
})
