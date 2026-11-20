import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { CRDT_SYNC_ITEM_TYPES } from '@memry/contracts/sync-api'
import { SimulatedServer } from '../src/simulated-server.js'
import { SimulatedDevice } from '../src/simulated-device.js'
import { createTestDevice } from '../src/test-auth.js'
import { generateVaultKey, initCrypto } from '../src/crypto.js'
import { harnessDigests } from '../src/harness-digest.js'
import type { DeviceIdentity, FetchFn } from '../src/types.js'
import {
  checkBootstrapCreated,
  checkSemantic,
  checkStructural,
  fetchServerTruth,
  formatFindings,
  type ServerVaultTruth,
  type StructuralReport
} from '../src/zero-loss-oracle/index.js'

// #5225 step 02b: bootstrap scenarios on the real Worker (Miniflare D1 and R2)
// with a fresh device that takes today's item-granular path: the change feed,
// `/sync/pull`, then each body through the snapshot GET and the updates batch.
// Every scenario ends with the zero-loss oracle on the quiescent vault: the
// structural check against the server, and the semantic check against a second
// device that bootstrapped after every write.

const server = new SimulatedServer()
const serverFetch: FetchFn = (input, init) => server.fetch(input, init)

const urlOf = (input: RequestInfo | URL): string =>
  input instanceof Request ? input.url : input.toString()

const bytes = (...values: number[]): string => Buffer.from(values).toString('base64')

interface Vault {
  author: SimulatedDevice
  authorId: DeviceIdentity
  /** A fresh device of the same account and vault, reading through `fetchFn`. */
  freshDevice: (fetchFn?: FetchFn) => Promise<SimulatedDevice>
}

const readTruth = (identity: DeviceIdentity): Promise<ServerVaultTruth> =>
  fetchServerTruth({
    baseUrl: 'http://localhost',
    accessToken: identity.accessToken,
    fetch: serverFetch
  })

/** The server each fresh device met, read before its bootstrap starts (#5261). */
const truthBeforeBootstrap = new WeakMap<SimulatedDevice, ServerVaultTruth>()

const openVault = async (): Promise<Vault> => {
  const vaultKey = generateVaultKey()
  const authorId = await createTestDevice(server, { deviceName: 'author', vaultKey })
  const author = new SimulatedDevice(authorId, serverFetch)
  return {
    author,
    authorId,
    freshDevice: async (fetchFn = serverFetch) => {
      const identity = await createTestDevice(server, { userId: authorId.userId, vaultKey })
      const device = new SimulatedDevice(identity, fetchFn)
      device.registerPeerDevice(authorId.deviceId, authorId.signingPublicKey)
      truthBeforeBootstrap.set(device, await readTruth(identity))
      return device
    }
  }
}

const post = async (identity: DeviceIdentity, path: string, body: unknown): Promise<unknown> => {
  const res = await server.fetch(`http://localhost${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${identity.accessToken}`
    },
    body: JSON.stringify(body)
  })
  if (res.status !== 200) throw new Error(`${path} answered ${res.status}: ${await res.text()}`)
  return res.json()
}

const pushUpdates = (identity: DeviceIdentity, noteId: string, updates: string[]) =>
  post(identity, '/sync/crdt/updates', { noteId, updates })

const pushSnapshot = (identity: DeviceIdentity, noteId: string, snapshot: string) =>
  post(identity, '/sync/crdt/snapshot', { noteId, snapshot })

/** Pushes in pages of 100, the push route's cap. */
const pushAll = async (device: SimulatedDevice, items = [...device.getAllItems().values()]) => {
  for (let i = 0; i < items.length; i += 100) {
    const res = await device.push(items.slice(i, i + 100))
    if (res.rejected.length > 0) throw new Error(`push rejected ${JSON.stringify(res.rejected)}`)
  }
}

/** Pushes `notes` notes, then `tasks` tasks, in feed order; returns the note ids. */
const seed = async (author: SimulatedDevice, notes: number, tasks: number): Promise<string[]> => {
  const ids = Array.from({ length: notes }, () => crypto.randomUUID())
  for (const id of ids) await author.createItem('note', id, { title: id.slice(0, 8) })
  for (let i = 0; i < tasks; i++) await author.createItem('task', crypto.randomUUID(), { n: i })
  await pushAll(author)
  return ids
}

const crdtTypes = new Set<string>(CRDT_SYNC_ITEM_TYPES)

const liveDocumentIds = (device: SimulatedDevice): string[] =>
  [...device.getAllItems().values()]
    .filter((item) => item.operation !== 'delete' && crdtTypes.has(item.type))
    .map((item) => item.id)

/**
 * Today's item-granular bootstrap: drain the record feed, then pull the body of
 * every live document the device does not hold yet. The device's maps stand in
 * for its database, so a relaunch after a kill keeps what was applied, and the
 * record feed resumes from the persisted cursor.
 */
const bootstrap = async (device: SimulatedDevice): Promise<void> => {
  await device.pull()
  const held = device.oracleState().bodies
  for (const id of liveDocumentIds(device)) {
    if (!held[id]) await device.pullBodies([id])
  }
}

/** Runs the oracle on the quiescent vault and returns the report it printed. */
const runOracle = async (
  label: string,
  device: SimulatedDevice,
  vault: Vault
): Promise<StructuralReport> => {
  const truth = await readTruth(vault.authorId)
  const reference = await vault.freshDevice()
  await bootstrap(reference)
  const report = checkStructural(truth, device.oracleState())
  const semantic = checkSemantic(
    harnessDigests('device', device),
    harnessDigests('reference', reference)
  )
  const before = truthBeforeBootstrap.get(device)
  if (!before) throw new Error('runOracle: device was not made by freshDevice')
  const created = checkBootstrapCreated(before, truth, device.identity.deviceId)
  console.log(
    `[#5225 ${label}]\n${formatFindings([...report.findings, ...semantic, ...created], report.counts)}`
  )
  expect(report.findings).toEqual([])
  expect(semantic).toEqual([])
  expect(created).toEqual([])
  return report
}

describe('Sync Harness — bootstrap scenarios under the zero-loss oracle (#5225)', () => {
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

  it('a clean bootstrap holds every record and body', async () => {
    const vault = await openVault()
    const { author, authorId } = vault
    const withUpdates = crypto.randomUUID()
    const withSnapshot = crypto.randomUUID()
    const empty = crypto.randomUUID()
    const task = crypto.randomUUID()
    for (const id of [withUpdates, withSnapshot, empty]) {
      await author.createItem('note', id, { title: id.slice(0, 8) })
    }
    await author.createItem('task', task, { title: 'task' })
    await pushAll(author)
    await pushUpdates(authorId, withUpdates, [bytes(1), bytes(2)])
    await pushSnapshot(authorId, withSnapshot, bytes(9, 9))
    await pushUpdates(authorId, withSnapshot, [bytes(3)])

    const device = await vault.freshDevice()
    await bootstrap(device)

    const report = await runOracle('clean', device, vault)
    expect(report.counts).toEqual({ expected_empty: 1, body_without_record: 0 })
    expect(Object.keys(device.oracleState().records)).toHaveLength(4)
  })

  it('a document deleted before the bootstrap stays deleted', async () => {
    const vault = await openVault()
    const { author, authorId } = vault
    const kept = crypto.randomUUID()
    const gone = crypto.randomUUID()
    await author.createItem('note', kept, { title: 'kept' })
    await author.createItem('note', gone, { title: 'gone' })
    await pushAll(author)
    await pushUpdates(authorId, kept, [bytes(1)])
    await pushSnapshot(authorId, gone, bytes(7, 7))
    await pushUpdates(authorId, gone, [bytes(2)])
    await pushAll(author, [await author.deleteItem(gone)])

    const device = await vault.freshDevice()
    await bootstrap(device)

    await runOracle('deleted-before', device, vault)
    expect(device.getItem(gone)).toBeUndefined()
    expect(device.oracleState().records[gone]?.deleted).toBe(true)
    expect(device.oracleState().bodies[gone]).toBeUndefined()
  })

  it('a document deleted and re-created with the same id holds only the new body', async () => {
    const vault = await openVault()
    const { author, authorId } = vault
    const id = crypto.randomUUID()
    await author.createItem('note', id, { title: 'first life' })
    await pushAll(author)
    await pushSnapshot(authorId, id, bytes(1, 1))
    await pushUpdates(authorId, id, [bytes(2), bytes(3)])
    await pushAll(author, [await author.deleteItem(id)])
    await pushAll(author, [await author.createItem('note', id, { title: 'second life' })])
    await pushUpdates(authorId, id, [bytes(4)])

    const device = await vault.freshDevice()
    await bootstrap(device)

    await runOracle('re-created', device, vault)
    expect(device.getItem(id)?.content).toEqual({ title: 'second life' })
    expect(device.getBodyParts(id)).toEqual([bytes(4)])
  })

  it('a snapshot superseded by a newer one: the device holds the newer baseline', async () => {
    const vault = await openVault()
    const { author, authorId } = vault
    const id = crypto.randomUUID()
    await author.createItem('note', id, { title: 'snapshots' })
    await pushAll(author)
    await pushSnapshot(authorId, id, bytes(1, 1))
    await pushUpdates(authorId, id, [bytes(2), bytes(3)])
    await pushSnapshot(authorId, id, bytes(1, 2, 3))
    await pushUpdates(authorId, id, [bytes(4)])

    const device = await vault.freshDevice()
    await bootstrap(device)

    await runOracle('superseded', device, vault)
    expect(device.getBodyParts(id)[0]).toBe(bytes(1, 2, 3))
    expect(device.getBodyParts(id)).not.toContain(bytes(1, 1))
  })

  it('an edit and a delete from a second device during the bootstrap', async () => {
    const vault = await openVault()
    const { author, authorId } = vault
    // More records than one feed page (limit 100), so the bootstrap is
    // mid-feed when the second device writes. Tasks fill the page: a body pull
    // per note would trip the Worker's per-device rate limit.
    const ids = await seed(author, 8, 110)
    for (const id of ids.slice(0, 4)) await pushUpdates(authorId, id, [bytes(1)])
    const [editedInFeed, deletedInFeed, editedInBodies, deletedInBodies] = ids

    const writes: Record<string, () => Promise<void>> = {
      '/sync/changes': async () => {
        await pushAll(author, [
          await author.updateItem(editedInFeed, { title: 'edited mid-feed' }),
          await author.deleteItem(deletedInFeed)
        ])
        await pushUpdates(authorId, editedInFeed, [bytes(2)])
      },
      '/sync/crdt/updates/batch': async () => {
        await pushAll(author, [
          await author.updateItem(editedInBodies, { title: 'edited mid-bodies' }),
          await author.deleteItem(deletedInBodies)
        ])
        await pushUpdates(authorId, editedInBodies, [bytes(3)])
      }
    }
    const duringBootstrap: FetchFn = async (input, init) => {
      const res = await serverFetch(input, init)
      const path = new URL(urlOf(input)).pathname
      const write = writes[path]
      if (write) {
        delete writes[path]
        await write()
      }
      return res
    }

    const device = await vault.freshDevice(duringBootstrap)
    await bootstrap(device)
    expect(writes).toEqual({})
    // The writes landed past the device's cursor or after its body pulls;
    // its next sync, the ordinary one after a bootstrap, catches them up.
    await device.pull()
    await device.pullBodies(liveDocumentIds(device))

    const report = await runOracle('second-device-writes', device, vault)
    expect(device.getItem(editedInFeed)?.content).toEqual({ title: 'edited mid-feed' })
    expect(device.getItem(editedInBodies)?.content).toEqual({ title: 'edited mid-bodies' })
    expect(device.getItem(deletedInFeed)).toBeUndefined()
    expect(device.getItem(deletedInBodies)).toBeUndefined()
    expect(device.getBodyParts(editedInFeed)).toEqual([bytes(1), bytes(2)])
    expect(device.getBodyParts(editedInBodies)).toEqual([bytes(1), bytes(3)])
    expect(report.counts).toEqual({ expected_empty: ids.length - 4, body_without_record: 1 })
  })

  it('a bootstrap killed mid-feed and mid-bodies resumes to the whole vault', async () => {
    const vault = await openVault()
    const { author, authorId } = vault
    const ids = await seed(author, 12, 110)
    for (const id of ids.slice(0, 10)) await pushUpdates(authorId, id, [bytes(1), bytes(2)])

    // The process dies at the n-th request of a path: the request never answers.
    let killAt: { path: string; n: number } | null = null
    const killable: FetchFn = async (input, init) => {
      const path = new URL(urlOf(input)).pathname
      if (killAt && path.startsWith(killAt.path) && --killAt.n === 0) {
        killAt = null
        throw new Error(`killed at ${path}`)
      }
      return serverFetch(input, init)
    }
    const device = await vault.freshDevice(killable)

    killAt = { path: '/sync/pull', n: 2 }
    await expect(bootstrap(device)).rejects.toThrow('killed at /sync/pull')
    const afterFeedKill = Object.keys(device.oracleState().records).length
    expect(afterFeedKill).toBeGreaterThan(0)
    expect(afterFeedKill).toBeLessThan(ids.length + 110)

    killAt = { path: '/sync/crdt/', n: 9 }
    await expect(bootstrap(device)).rejects.toThrow('killed at /sync/crdt/')
    const afterBodyKill = Object.keys(device.oracleState().bodies).length
    expect(afterBodyKill).toBeGreaterThan(0)
    expect(afterBodyKill).toBeLessThan(ids.length)

    await bootstrap(device)

    const report = await runOracle('killed-resumed', device, vault)
    expect(report.counts).toEqual({ expected_empty: ids.length - 10, body_without_record: 0 })
  })
})
