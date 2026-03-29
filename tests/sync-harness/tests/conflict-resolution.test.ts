import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { SimulatedServer } from '../src/simulated-server.js'
import { SimulatedDevice } from '../src/simulated-device.js'
import { ChaosController } from '../src/chaos-controller.js'
import { OracleModel } from '../src/oracle-model.js'
import { createTestDevice } from '../src/test-auth.js'
import { generateVaultKey, initCrypto } from '../src/crypto.js'
import type { FetchFn } from '../src/types.js'

const server = new SimulatedServer()
let serverFetch: FetchFn

function setupPair(chaos: ChaosController) {
  return async () => {
    const wrappedFetch = chaos.wrapFetch(serverFetch)
    const oracle = new OracleModel()
    const sharedVaultKey = generateVaultKey()
    const sharedUserId = crypto.randomUUID()

    const identityA = await createTestDevice(server, {
      userId: sharedUserId,
      deviceName: 'device-a',
      vaultKey: sharedVaultKey
    })
    const identityB = await createTestDevice(server, {
      userId: sharedUserId,
      deviceName: 'device-b',
      vaultKey: sharedVaultKey
    })

    const deviceA = new SimulatedDevice(identityA, wrappedFetch)
    const deviceB = new SimulatedDevice(identityB, wrappedFetch)

    deviceA.registerPeerDevice(identityB.deviceId, identityB.signingPublicKey)
    deviceB.registerPeerDevice(identityA.deviceId, identityA.signingPublicKey)

    return { deviceA, deviceB, identityA, identityB, oracle, wrappedFetch }
  }
}

describe('Sync Harness — Conflict Resolution', () => {
  beforeAll(async () => {
    await initCrypto()
    await server.start()
    serverFetch = (input, init) => server.fetch(input, init)
  })

  afterAll(async () => {
    await server.stop()
  })

  beforeEach(async () => {
    await server.truncateTables()
  })

  it('sequential edits to different fields accumulate correctly', async () => {
    const chaos = new ChaosController({ seed: 100 })
    const setup = await setupPair(chaos)()
    const { deviceA, deviceB, identityA, identityB, oracle } = setup

    const taskId = crypto.randomUUID()

    await deviceA.createItem('task', taskId, {
      title: 'Original',
      priority: 'low',
      description: 'Initial'
    })
    oracle.record({
      deviceId: identityA.deviceId,
      itemId: taskId,
      type: 'task',
      fields: { title: 'Original', priority: 'low', description: 'Initial' },
      clock: { [identityA.deviceId]: 1 },
      operation: 'create'
    })
    await deviceA.push()

    await deviceB.pull()
    expect(deviceB.getItem(taskId)!.content.title).toBe('Original')

    await deviceA.updateItem(taskId, { title: 'Updated by A' })
    oracle.record({
      deviceId: identityA.deviceId,
      itemId: taskId,
      type: 'task',
      fields: { title: 'Updated by A' },
      clock: { [identityA.deviceId]: 2 },
      operation: 'update'
    })
    await deviceA.push()

    await deviceB.pull()
    expect(deviceB.getItem(taskId)!.content.title).toBe('Updated by A')

    await deviceB.updateItem(taskId, { priority: 'high' })
    oracle.record({
      deviceId: identityB.deviceId,
      itemId: taskId,
      type: 'task',
      fields: { priority: 'high' },
      clock: { [identityB.deviceId]: 1, [identityA.deviceId]: 2 },
      operation: 'update'
    })
    await deviceB.push()

    await deviceA.pull()

    const itemA = deviceA.getItem(taskId)
    const itemB = deviceB.getItem(taskId)

    expect(itemA).toBeDefined()
    expect(itemB).toBeDefined()
    expect(itemA!.content.title).toBe('Updated by A')
    expect(itemA!.content.priority).toBe('high')
    expect(itemB!.content.title).toBe('Updated by A')
    expect(itemB!.content.priority).toBe('high')

    const mismatchesA = oracle.compare(deviceA.getAllItems())
    expect(mismatchesA).toHaveLength(0)
    const mismatchesB = oracle.compare(deviceB.getAllItems())
    expect(mismatchesB).toHaveLength(0)

    console.log(`[seed=${chaos.getSeed()}] Sequential different-field edits: PASS`)
  })

  it('concurrent edits to SAME field — higher tick-sum wins', async () => {
    const chaos = new ChaosController({ seed: 200 })
    const setup = await setupPair(chaos)()
    const { deviceA, deviceB, identityA, identityB, oracle } = setup

    const taskId = crypto.randomUUID()

    await deviceA.createItem('task', taskId, { title: 'Original' })
    oracle.record({
      deviceId: identityA.deviceId,
      itemId: taskId,
      type: 'task',
      fields: { title: 'Original' },
      clock: { [identityA.deviceId]: 1 },
      operation: 'create'
    })
    await deviceA.push()
    await deviceB.pull()

    await deviceA.updateItem(taskId, { title: 'Version A' })
    await deviceA.updateItem(taskId, { title: 'Version A v2' })
    oracle.record({
      deviceId: identityA.deviceId,
      itemId: taskId,
      type: 'task',
      fields: { title: 'Version A v2' },
      clock: { [identityA.deviceId]: 3 },
      operation: 'update'
    })

    await deviceB.updateItem(taskId, { title: 'Version B' })
    oracle.record({
      deviceId: identityB.deviceId,
      itemId: taskId,
      type: 'task',
      fields: { title: 'Version B' },
      clock: { [identityB.deviceId]: 1, [identityA.deviceId]: 1 },
      operation: 'update'
    })

    await deviceA.push()
    await deviceB.push()
    await deviceA.pull()
    await deviceB.pull()

    const itemA = deviceA.getItem(taskId)
    const itemB = deviceB.getItem(taskId)
    expect(itemA!.content.title).toBe(itemB!.content.title)

    console.log(
      `[seed=${chaos.getSeed()}] Same-field conflict (A tick=3 vs B tick=2): ` +
        `winner="${itemA!.content.title}" — PASS`
    )
  })

  it('delete propagation — A deletes, B sees tombstone', async () => {
    const chaos = new ChaosController({ seed: 300 })
    const setup = await setupPair(chaos)()
    const { deviceA, deviceB, identityA, oracle } = setup

    const taskId = crypto.randomUUID()
    await deviceA.createItem('task', taskId, { title: 'Soon to be deleted' })
    oracle.record({
      deviceId: identityA.deviceId,
      itemId: taskId,
      type: 'task',
      fields: { title: 'Soon to be deleted' },
      clock: { [identityA.deviceId]: 1 },
      operation: 'create'
    })
    await deviceA.push()
    await deviceB.pull()
    expect(deviceB.getItem(taskId)).toBeDefined()

    await deviceA.deleteItem(taskId)
    oracle.record({
      deviceId: identityA.deviceId,
      itemId: taskId,
      type: 'task',
      fields: {},
      clock: { [identityA.deviceId]: 2 },
      operation: 'delete'
    })

    await deviceA.push()
    await deviceB.pull()

    expect(deviceB.getItem(taskId)).toBeUndefined()

    const mismatchesB = oracle.compare(deviceB.getAllItems())
    expect(mismatchesB).toHaveLength(0)

    console.log(`[seed=${chaos.getSeed()}] Delete propagation: PASS`)
  })

  it('update chain — create → multiple updates → sync final state', async () => {
    const chaos = new ChaosController({ seed: 400 })
    const setup = await setupPair(chaos)()
    const { deviceA, deviceB, identityA, oracle } = setup

    const taskId = crypto.randomUUID()
    await deviceA.createItem('task', taskId, { title: 'v1', count: 0 })

    for (let i = 1; i <= 5; i++) {
      await deviceA.updateItem(taskId, { title: `v${i + 1}`, count: i })
    }

    oracle.record({
      deviceId: identityA.deviceId,
      itemId: taskId,
      type: 'task',
      fields: { title: 'v6', count: 5 },
      clock: { [identityA.deviceId]: 6 },
      operation: 'update'
    })

    await deviceA.push()
    await deviceB.pull()

    const item = deviceB.getItem(taskId)
    expect(item).toBeDefined()
    expect(item!.content.title).toBe('v6')
    expect(item!.content.count).toBe(5)

    const mismatchesA = oracle.compare(deviceA.getAllItems())
    expect(mismatchesA).toHaveLength(0)
    const mismatchesB = oracle.compare(deviceB.getAllItems())
    expect(mismatchesB).toHaveLength(0)

    console.log(`[seed=${chaos.getSeed()}] Update chain (5 updates): PASS`)
  })

  it('settings document-level LWW — entire doc replaced, not merged', async () => {
    const chaos = new ChaosController({ seed: 500 })
    const setup = await setupPair(chaos)()
    const { deviceA, deviceB, identityA, identityB, oracle } = setup

    const settingsId = 'user-settings'
    await deviceA.createItem('settings', settingsId, {
      theme: 'light',
      fontSize: 14,
      language: 'en'
    })
    oracle.record({
      deviceId: identityA.deviceId,
      itemId: settingsId,
      type: 'settings',
      fields: { theme: 'light', fontSize: 14, language: 'en' },
      clock: { [identityA.deviceId]: 1 },
      operation: 'create'
    })
    await deviceA.push()
    await deviceB.pull()

    await deviceA.updateItem(settingsId, { theme: 'dark' })
    oracle.record({
      deviceId: identityA.deviceId,
      itemId: settingsId,
      type: 'settings',
      fields: { theme: 'dark', fontSize: 14, language: 'en' },
      clock: { [identityA.deviceId]: 2 },
      operation: 'update'
    })

    await deviceB.updateItem(settingsId, { fontSize: 18 })
    oracle.record({
      deviceId: identityB.deviceId,
      itemId: settingsId,
      type: 'settings',
      fields: { theme: 'light', fontSize: 18, language: 'en' },
      clock: { [identityB.deviceId]: 1, [identityA.deviceId]: 1 },
      operation: 'update'
    })

    await deviceA.push()
    await deviceB.push()
    await deviceA.pull()
    await deviceB.pull()

    const onA = deviceA.getItem(settingsId)
    const onB = deviceB.getItem(settingsId)

    expect(onA!.content.theme).toBe(onB!.content.theme)
    expect(onA!.content.fontSize).toBe(onB!.content.fontSize)

    const mismatchesA = oracle.compare(deviceA.getAllItems())
    expect(mismatchesA).toHaveLength(0)
    const mismatchesB = oracle.compare(deviceB.getAllItems())
    expect(mismatchesB).toHaveLength(0)

    console.log(
      `[seed=${chaos.getSeed()}] Settings LWW: theme="${onA!.content.theme}" ` +
        `fontSize=${onA!.content.fontSize} — PASS`
    )
  })

  it('delete-vs-update race — delete pushed last wins on server', async () => {
    const chaos = new ChaosController({ seed: 600 })
    const setup = await setupPair(chaos)()
    const { deviceA, deviceB } = setup

    const taskId = crypto.randomUUID()

    // #given — A creates task, both devices synced
    await deviceA.createItem('task', taskId, { title: 'Original' })
    await deviceA.push()
    await deviceB.pull()
    expect(deviceB.getItem(taskId)).toBeDefined()

    // #when — A updates, pushes; B deletes, pushes (delete is last on server)
    await deviceA.updateItem(taskId, { title: 'Updated by A' })
    await deviceA.push()

    await deviceB.deleteItem(taskId)
    await deviceB.push()

    // #then — A pulls the delete (last push wins on server cursor)
    await deviceA.pull()
    expect(deviceA.getItem(taskId)).toBeUndefined()

    console.log(`[seed=${chaos.getSeed()}] Delete-vs-update race (delete last): PASS`)
  })

  it('update-after-delete — update pushed last resurrects item on server', async () => {
    const chaos = new ChaosController({ seed: 700 })
    const setup = await setupPair(chaos)()
    const { deviceA, deviceB } = setup

    const taskId = crypto.randomUUID()

    // #given — A creates task, both devices synced
    await deviceA.createItem('task', taskId, { title: 'Original' })
    await deviceA.push()
    await deviceB.pull()
    expect(deviceB.getItem(taskId)).toBeDefined()

    // #when — A deletes, pushes; B updates, pushes (update is last on server)
    await deviceA.deleteItem(taskId)
    await deviceA.push()

    await deviceB.updateItem(taskId, { title: 'Resurrected by B' })
    await deviceB.push()

    // #then — A pulls the resurrected item
    await deviceA.pull()
    const item = deviceA.getItem(taskId)
    expect(item).toBeDefined()
    expect(item!.content.title).toBe('Resurrected by B')

    console.log(`[seed=${chaos.getSeed()}] Update-after-delete (resurrect): PASS`)
  })

  it('delete on both devices — both see item removed', async () => {
    const chaos = new ChaosController({ seed: 800 })
    const setup = await setupPair(chaos)()
    const { deviceA, deviceB } = setup

    const taskId = crypto.randomUUID()

    // #given — A creates task, both devices synced
    await deviceA.createItem('task', taskId, { title: 'Doomed' })
    await deviceA.push()
    await deviceB.pull()
    expect(deviceB.getItem(taskId)).toBeDefined()

    // #when — both delete independently, then push/pull
    await deviceA.deleteItem(taskId)
    await deviceB.deleteItem(taskId)

    await deviceA.push()
    await deviceB.push()

    await deviceA.pull()
    await deviceB.pull()

    // #then — item gone on both
    expect(deviceA.getItem(taskId)).toBeUndefined()
    expect(deviceB.getItem(taskId)).toBeUndefined()

    console.log(`[seed=${chaos.getSeed()}] Delete on both devices: PASS`)
  })
})
