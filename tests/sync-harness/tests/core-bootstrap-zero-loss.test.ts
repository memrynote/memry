import { createHash } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import * as Y from 'yjs'
import { SimulatedServer } from '../src/simulated-server.js'
import { SimulatedDevice } from '../src/simulated-device.js'
import { createTestDevice } from '../src/test-auth.js'
import { deriveVaultKey, encryptCrdtPacked, initCrypto } from '../src/crypto.js'
import {
  CoreDevice,
  R2_PRESIGN_BINDINGS,
  type CoreOracleState,
  type CoreRun,
  type KillPoint
} from '../src/core-device.js'
import type { DeviceIdentity, FetchFn } from '../src/types.js'
import {
  checkBootstrapCreated,
  checkSemantic,
  checkStructural,
  fetchServerTruth,
  formatFindings,
  type DeviceDigests,
  type ServerVaultTruth
} from '../src/zero-loss-oracle/index.js'

// #5232 step 09: the zero-loss oracle on a fresh Rust core device that takes
// the vault from packs. The vault is written by a TypeScript device with real
// encrypted Yjs bodies, packed by the Worker's own cron backfill (record,
// crdt_snapshot and crdt_update packs), then written to again so the tail and
// the window pulls have work. The core device is the `memry` CLI running
// `Vault::first_sync` and its body passes (`core-device.ts`).

const server = new SimulatedServer()
const serverFetch: FetchFn = (input, init) => server.fetch(input, init)

/** Rows older than the backfill's settle window (`PACK_SETTLE_SECONDS`, 24 h). */
const BACKDATE_SECONDS = 2 * 24 * 60 * 60

interface Author {
  device: SimulatedDevice
  identity: DeviceIdentity
  masterKey: Uint8Array
  vaultKey: Uint8Array
  /** Every body the author wrote, keyed by note id. */
  docs: Map<string, Y.Doc>
}

const post = async (identity: DeviceIdentity, path: string, body: unknown): Promise<void> => {
  const res = await server.fetch(`http://localhost${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${identity.accessToken}`
    },
    body: JSON.stringify(body)
  })
  if (res.status !== 200) throw new Error(`${path} answered ${res.status}: ${await res.text()}`)
}

const pushRecords = async (author: Author, items = [...author.device.getAllItems().values()]) => {
  for (let i = 0; i < items.length; i += 100) {
    const res = await author.device.push(items.slice(i, i + 100))
    if (res.rejected.length > 0) throw new Error(`push rejected ${JSON.stringify(res.rejected)}`)
  }
}

const sealed = (author: Author, noteId: string, bytes: Uint8Array): string =>
  Buffer.from(
    encryptCrdtPacked(bytes, author.vaultKey, noteId, author.identity.signingSecretKey)
  ).toString('base64')

/** Appends `text` to a note's body and pushes the edit as one update. */
const edit = async (author: Author, noteId: string, text: string): Promise<void> => {
  let doc = author.docs.get(noteId)
  if (!doc) {
    doc = new Y.Doc()
    author.docs.set(noteId, doc)
  }
  const before = Y.encodeStateVector(doc)
  doc.getText('harness').insert(doc.getText('harness').length, text)
  const update = Y.encodeStateAsUpdate(doc, before)
  await post(author.identity, '/sync/crdt/updates', {
    noteId,
    updates: [sealed(author, noteId, update)]
  })
}

const snapshot = (author: Author, noteId: string): Promise<void> =>
  post(author.identity, '/sync/crdt/snapshot', {
    noteId,
    snapshot: sealed(author, noteId, Y.encodeStateAsUpdate(author.docs.get(noteId)!))
  })

/** A record whose payload carries its clock, as every shell's does (the core reads it there). */
const create = async (author: Author, type: 'note' | 'task', title: string): Promise<string> => {
  const id = crypto.randomUUID()
  const item = await author.device.createItem(type, id, { title })
  item.content = { ...item.content, clock: item.clock }
  return id
}

const packKinds = async (): Promise<Record<string, number>> => {
  const db = await server.getD1()
  const { results } = await db
    .prepare('SELECT item_kind, COUNT(*) AS n FROM pack_index GROUP BY item_kind')
    .all<{ item_kind: string; n: number }>()
  return Object.fromEntries(results.map((row) => [row.item_kind, row.n]))
}

/** Runs the cron until it packs nothing more. */
const settlePacks = async (): Promise<Record<string, number>> => {
  let kinds = await packKinds()
  for (let tick = 0; tick < 10; tick++) {
    await server.triggerScheduled()
    const next = await packKinds()
    if (JSON.stringify(next) === JSON.stringify(kinds)) break
    kinds = next
  }
  return kinds
}

/** Backdates every row past the settle window, so the cron packs it. */
const backdate = async (): Promise<void> => {
  const db = await server.getD1()
  await db.batch([
    db.prepare('UPDATE sync_items SET updated_at = updated_at - ?').bind(BACKDATE_SECONDS),
    db.prepare('UPDATE crdt_updates SET created_at = created_at - ?').bind(BACKDATE_SECONDS),
    db.prepare('UPDATE crdt_snapshots SET created_at = created_at - ?').bind(BACKDATE_SECONDS)
  ])
}

/**
 * The vault: notes with bodies (some with a snapshot and later updates), a note
 * with no body, a deleted note, and tasks, all packed; then writes after the
 * packs: new notes, an edit and a delete of packed notes.
 */
const seedVault = async (): Promise<{ author: Author; packs: Record<string, number> }> => {
  const masterKey = crypto.getRandomValues(new Uint8Array(32))
  const vaultKey = deriveVaultKey(masterKey)
  const identity = await createTestDevice(server, { deviceName: 'author', vaultKey })
  const author: Author = {
    device: new SimulatedDevice(identity, serverFetch),
    identity,
    masterKey,
    vaultKey,
    docs: new Map()
  }

  const notes: string[] = []
  for (let i = 0; i < 30; i++) notes.push(await create(author, 'note', `packed ${i}`))
  await create(author, 'note', 'no body')
  const doomed = await create(author, 'note', 'deleted before the packs')
  for (let i = 0; i < 20; i++) {
    await create(author, 'task', `task ${i}`)
  }
  await pushRecords(author)
  for (const [i, id] of [...notes, doomed].entries()) {
    await edit(author, id, `first ${i} `)
    await edit(author, id, `second ${i} `)
    if (i < 10) {
      await snapshot(author, id)
      await edit(author, id, `after the snapshot ${i}`)
    }
  }
  await pushRecords(author, [await author.device.deleteItem(doomed)])
  author.docs.delete(doomed)

  await backdate()
  await settlePacks()

  // After the packs: the tail and the window pulls carry these.
  const late: string[] = []
  for (let i = 0; i < 4; i++) late.push(await create(author, 'note', `late ${i}`))
  await pushRecords(
    author,
    late.map((id) => author.device.getItem(id)!)
  )
  for (const id of late) await edit(author, id, 'written after the packs')
  await edit(author, notes[0], ' edited after the packs')
  await edit(author, notes[12], ' edited after the packs')
  await pushRecords(author, [await author.device.deleteItem(notes[20])])
  author.docs.delete(notes[20])
  // The delete purges the packs holding that body (scoped purge, #5254); the cron rebuilds
  // the backdated range and leaves the young rows above to the routes.
  const packs = await settlePacks()
  return { author, packs }
}

const readTruth = (identity: DeviceIdentity): Promise<ServerVaultTruth> =>
  fetchServerTruth({
    baseUrl: 'http://localhost',
    accessToken: identity.accessToken,
    fetch: serverFetch
  })

const stateVectorText = (vector: Map<number, number> | undefined): string =>
  [...(vector ?? new Map<number, number>()).entries()]
    // oxlint-disable-next-line unicorn/no-array-sort -- tsconfig target ES2022 has no Array#toSorted; the array is a fresh spread
    .sort(([a], [b]) => a - b)
    .map(([client, clock]) => `${client}:${clock}`)
    .join(',')

const digest = (content: unknown, vector: Map<number, number> | undefined): string =>
  createHash('sha256')
    .update(`${JSON.stringify(content)}\n${stateVectorText(vector)}`)
    .digest('hex')

const authorDigests = (author: Author): DeviceDigests => {
  const digests: Record<string, string> = {}
  for (const item of author.device.getAllItems().values()) {
    if (item.operation === 'delete') continue
    const doc = author.docs.get(item.id)
    digests[item.id] = digest(item.content, doc && Y.decodeStateVector(Y.encodeStateVector(doc)))
  }
  return { label: 'author', digests }
}

const coreDigests = (state: CoreOracleState): DeviceDigests => {
  const digests: Record<string, string> = {}
  for (const [id, payload] of Object.entries(state.payloads)) {
    const vector = state.stateVectors[id]
    digests[id] = digest(
      JSON.parse(payload),
      vector === undefined ? undefined : Y.decodeStateVector(Buffer.from(vector, 'hex'))
    )
  }
  return { label: 'core', digests }
}

describe('Sync Harness — a core bootstrap from packs under the zero-loss oracle (#5232)', () => {
  beforeAll(async () => {
    await initCrypto()
    // Staging's shape: presigned pack URLs and elevated bootstrap sessions.
    await server.start({
      bindings: { ...R2_PRESIGN_BINDINGS, BOOTSTRAP_SESSION_HMAC_KEY: 'harness-bootstrap-key' }
    })
  })

  afterAll(async () => {
    await server.stop()
  })

  beforeEach(async () => {
    await server.truncateTables()
  })

  const bootstrapUnderOracle = async (label: string, kills: KillPoint[]) => {
    const { author, packs } = await seedVault()
    expect(packs).toEqual({
      record: expect.any(Number),
      crdt_snapshot: expect.any(Number),
      crdt_update: expect.any(Number)
    })

    const identity = await createTestDevice(server, {
      userId: author.identity.userId,
      vaultKey: author.vaultKey
    })
    const before = await readTruth(author.identity)
    const core = new CoreDevice(server, identity, author.masterKey)
    await core.start()
    try {
      const runs = []
      for (const killAt of kills) {
        runs.push(await core.bootstrap({ resume: runs.length > 0, killAt }))
      }
      const final = await core.bootstrap({ resume: runs.length > 0 })
      runs.push(final)
      console.log(
        `[#5232 ${label}] packs ${JSON.stringify(packs)}; requests per run ${runs
          .map((run) => run.requests.length)
          .join(', ')}\n  final run: ${final.requests.join(' ')}`
      )

      const state = await core.oracleState()
      const truth = await readTruth(author.identity)
      const report = checkStructural(truth, state)
      const semantic = checkSemantic(coreDigests(state), authorDigests(author))
      const created = checkBootstrapCreated(before, truth, identity.deviceId)
      console.log(
        `[#5232 ${label}]\n${formatFindings([...report.findings, ...semantic, ...created], report.counts)}`
      )
      expect(report.findings).toEqual([])
      expect(semantic).toEqual([])
      expect(created).toEqual([])
      expect(state.owed).toEqual([])
      expect(report.counts).toEqual({ expected_empty: 1, body_without_record: 0 })
      return runs
    } finally {
      await core.stop()
    }
  }

  const packDownloads = (requests: string[], kind: string): string[] =>
    requests.filter((p) => p.startsWith('/__r2/') && p.includes(`/packs/${kind}/`))

  it('a clean bootstrap from packs holds every record and body', async () => {
    const [run] = await bootstrapUnderOracle('clean', [])
    for (const kind of ['record', 'crdt_snapshot', 'crdt_update']) {
      expect(packDownloads(run.requests, kind)).toHaveLength(1)
    }
  })

  it('a bootstrap killed in each phase resumes to the whole vault', async () => {
    // Records (the record pack download), the reconcile (the manifest read
    // after the records), and bodies (the body check read after the body
    // packs are held). Each run resumes the one before it.
    const runs = await bootstrapUnderOracle('killed-resumed', [
      { path: '/__r2/', n: 1 },
      { path: '/sync/manifest', n: 1 },
      { path: '/sync/crdt/manifest', n: 1 }
    ])
    expect(runs.slice(0, 3).map((run) => run.killed)).toEqual([true, true, true])
    // The body packs were held when the third run died: the resume reads
    // them from the spill and downloads none again.
    const bodyPacks = (run: CoreRun) => [
      ...packDownloads(run.requests, 'crdt_snapshot'),
      ...packDownloads(run.requests, 'crdt_update')
    ]
    expect(bodyPacks(runs[2])).toHaveLength(2)
    expect(bodyPacks(runs[3])).toEqual([])
  })
})
