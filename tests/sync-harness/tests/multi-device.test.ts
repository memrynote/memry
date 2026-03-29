import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { SimulatedServer } from '../src/simulated-server.js'
import { SimulatedDevice } from '../src/simulated-device.js'
import { ChaosController } from '../src/chaos-controller.js'
import { OracleModel } from '../src/oracle-model.js'
import { createTestDevice } from '../src/test-auth.js'
import { generateVaultKey, initCrypto } from '../src/crypto.js'
import type { DeviceIdentity, FetchFn } from '../src/types.js'

const server = new SimulatedServer()
let serverFetch: FetchFn

async function createDeviceSet(
  count: number,
  wrappedFetch: FetchFn
): Promise<{
  devices: SimulatedDevice[]
  identities: DeviceIdentity[]
}> {
  const sharedVaultKey = generateVaultKey()
  const sharedUserId = crypto.randomUUID()

  const identities: DeviceIdentity[] = []
  for (let i = 0; i < count; i++) {
    identities.push(
      await createTestDevice(server, {
        userId: sharedUserId,
        deviceName: `device-${String.fromCharCode(65 + i)}`,
        vaultKey: sharedVaultKey
      })
    )
  }

  const devices = identities.map((id) => new SimulatedDevice(id, wrappedFetch))

  for (let i = 0; i < devices.length; i++) {
    for (let j = 0; j < devices.length; j++) {
      if (i !== j) {
        devices[i].registerPeerDevice(identities[j].deviceId, identities[j].signingPublicKey)
      }
    }
  }

  return { devices, identities }
}

describe('Sync Harness — Multi-Device', () => {
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

  it('three devices converge after triangle sync', async () => {
    const chaos = new ChaosController({ seed: 3000 })
    const wrappedFetch = chaos.wrapFetch(serverFetch)
    const oracle = new OracleModel()

    const { devices, identities } = await createDeviceSet(3, wrappedFetch)
    const [devA, devB, devC] = devices
    const [idA, idB, idC] = identities

    const taskFromA = crypto.randomUUID()
    await devA.createItem('task', taskFromA, { title: 'From A', owner: 'alice' })
    oracle.record({
      deviceId: idA.deviceId,
      itemId: taskFromA,
      type: 'task',
      fields: { title: 'From A', owner: 'alice' },
      clock: { [idA.deviceId]: 1 },
      operation: 'create'
    })

    const taskFromB = crypto.randomUUID()
    await devB.createItem('task', taskFromB, { title: 'From B', owner: 'bob' })
    oracle.record({
      deviceId: idB.deviceId,
      itemId: taskFromB,
      type: 'task',
      fields: { title: 'From B', owner: 'bob' },
      clock: { [idB.deviceId]: 1 },
      operation: 'create'
    })

    const taskFromC = crypto.randomUUID()
    await devC.createItem('task', taskFromC, { title: 'From C', owner: 'carol' })
    oracle.record({
      deviceId: idC.deviceId,
      itemId: taskFromC,
      type: 'task',
      fields: { title: 'From C', owner: 'carol' },
      clock: { [idC.deviceId]: 1 },
      operation: 'create'
    })

    await devA.push()
    await devB.push()
    await devC.push()

    await devA.pull()
    await devB.pull()
    await devC.pull()

    for (const [label, dev] of [
      ['A', devA],
      ['B', devB],
      ['C', devC]
    ] as const) {
      expect(dev.getItem(taskFromA)).toBeDefined()
      expect(dev.getItem(taskFromB)).toBeDefined()
      expect(dev.getItem(taskFromC)).toBeDefined()

      const mismatches = oracle.compare(dev.getAllItems())
      expect(mismatches).toHaveLength(0)
    }

    console.log(`[seed=${chaos.getSeed()}] 3-device triangle convergence: PASS`)
  })

  it('three devices — sequential edits propagate to observer C', async () => {
    const chaos = new ChaosController({ seed: 3100 })
    const wrappedFetch = chaos.wrapFetch(serverFetch)
    const oracle = new OracleModel()

    const { devices, identities } = await createDeviceSet(3, wrappedFetch)
    const [devA, devB, devC] = devices
    const [idA, idB] = identities

    const taskId = crypto.randomUUID()
    await devA.createItem('task', taskId, {
      title: 'Shared task',
      priority: 'low',
      status: 'todo'
    })
    oracle.record({
      deviceId: idA.deviceId,
      itemId: taskId,
      type: 'task',
      fields: { title: 'Shared task', priority: 'low', status: 'todo' },
      clock: { [idA.deviceId]: 1 },
      operation: 'create'
    })
    await devA.push()

    await devB.pull()

    await devA.updateItem(taskId, { title: 'Renamed by A' })
    oracle.record({
      deviceId: idA.deviceId,
      itemId: taskId,
      type: 'task',
      fields: { title: 'Renamed by A' },
      clock: { [idA.deviceId]: 2 },
      operation: 'update'
    })
    await devA.push()

    await devB.pull()
    expect(devB.getItem(taskId)!.content.title).toBe('Renamed by A')

    await devB.updateItem(taskId, { priority: 'critical' })
    oracle.record({
      deviceId: idB.deviceId,
      itemId: taskId,
      type: 'task',
      fields: { priority: 'critical' },
      clock: { [idB.deviceId]: 1, [idA.deviceId]: 2 },
      operation: 'update'
    })
    await devB.push()

    await devA.pull()
    await devC.pull()

    const itemOnC = devC.getItem(taskId)
    expect(itemOnC).toBeDefined()
    expect(itemOnC!.content.title).toBe('Renamed by A')
    expect(itemOnC!.content.priority).toBe('critical')
    expect(itemOnC!.content.status).toBe('todo')

    for (const dev of [devA, devB, devC]) {
      const mismatches = oracle.compare(dev.getAllItems())
      expect(mismatches).toHaveLength(0)
    }

    console.log(`[seed=${chaos.getSeed()}] 3-device sequential edit → observer C: PASS`)
  })

  it('large batch — 50 items pushed and pulled in one cycle', async () => {
    const chaos = new ChaosController({ seed: 5000 })
    const wrappedFetch = chaos.wrapFetch(serverFetch)
    const oracle = new OracleModel()

    const { devices, identities } = await createDeviceSet(2, wrappedFetch)
    const [devA, devB] = devices
    const [idA] = identities

    const itemIds: string[] = []
    for (let i = 0; i < 50; i++) {
      const id = crypto.randomUUID()
      itemIds.push(id)
      await devA.createItem('task', id, { title: `Task #${i}`, index: i })
      oracle.record({
        deviceId: idA.deviceId,
        itemId: id,
        type: 'task',
        fields: { title: `Task #${i}`, index: i },
        clock: { [idA.deviceId]: 1 },
        operation: 'create'
      })
    }

    const pushResult = await devA.push()
    expect(pushResult.accepted).toHaveLength(50)

    const pullResult = await devB.pull()
    expect(pullResult.applied).toBe(50)

    for (let i = 0; i < 50; i++) {
      const item = devB.getItem(itemIds[i])
      expect(item).toBeDefined()
      expect(item!.content.index).toBe(i)
    }

    const mismatches = oracle.compare(devB.getAllItems())
    expect(mismatches).toHaveLength(0)

    console.log(`[seed=${chaos.getSeed()}] 50-item batch sync: PASS`)
  })

  it('mixed types — tasks + settings + inbox in single push', async () => {
    const chaos = new ChaosController({ seed: 6000 })
    const wrappedFetch = chaos.wrapFetch(serverFetch)
    const oracle = new OracleModel()

    const { devices, identities } = await createDeviceSet(2, wrappedFetch)
    const [devA, devB] = devices
    const [idA] = identities

    const taskId = crypto.randomUUID()
    await devA.createItem('task', taskId, { title: 'Buy milk' })
    oracle.record({
      deviceId: idA.deviceId,
      itemId: taskId,
      type: 'task',
      fields: { title: 'Buy milk' },
      clock: { [idA.deviceId]: 1 },
      operation: 'create'
    })

    const settingsId = 'app-settings'
    await devA.createItem('settings', settingsId, { theme: 'dark', lang: 'tr' })
    oracle.record({
      deviceId: idA.deviceId,
      itemId: settingsId,
      type: 'settings',
      fields: { theme: 'dark', lang: 'tr' },
      clock: { [idA.deviceId]: 1 },
      operation: 'create'
    })

    const inboxId = crypto.randomUUID()
    await devA.createItem('inbox', inboxId, { title: 'Quick thought', type: 'text' })
    oracle.record({
      deviceId: idA.deviceId,
      itemId: inboxId,
      type: 'inbox',
      fields: { title: 'Quick thought', type: 'text' },
      clock: { [idA.deviceId]: 1 },
      operation: 'create'
    })

    const pushResult = await devA.push()
    expect(pushResult.accepted).toHaveLength(3)

    await devB.pull()

    expect(devB.getItem(taskId)!.content.title).toBe('Buy milk')
    expect(devB.getItem(settingsId)!.content.theme).toBe('dark')
    expect(devB.getItem(inboxId)!.content.title).toBe('Quick thought')

    const mismatches = oracle.compare(devB.getAllItems())
    expect(mismatches).toHaveLength(0)

    console.log(`[seed=${chaos.getSeed()}] Mixed-type sync (task+settings+inbox): PASS`)
  })

  it('sequential sync rounds — A pushes, B pulls, B pushes update, A pulls', async () => {
    const chaos = new ChaosController({ seed: 7000 })
    const wrappedFetch = chaos.wrapFetch(serverFetch)

    const { devices, identities } = await createDeviceSet(2, wrappedFetch)
    const [devA, devB] = devices

    const taskId = crypto.randomUUID()
    await devA.createItem('task', taskId, { title: 'Round 1', round: 1 })
    await devA.push()

    await devB.pull()
    expect(devB.getItem(taskId)!.content.round).toBe(1)

    await devB.updateItem(taskId, { title: 'Round 2', round: 2 })
    await devB.push()

    await devA.pull()
    expect(devA.getItem(taskId)!.content.round).toBe(2)
    expect(devA.getItem(taskId)!.content.title).toBe('Round 2')

    await devA.updateItem(taskId, { title: 'Round 3', round: 3 })
    await devA.push()

    await devB.pull()
    expect(devB.getItem(taskId)!.content.round).toBe(3)
    expect(devB.getItem(taskId)!.content.title).toBe('Round 3')

    console.log(`[seed=${chaos.getSeed()}] 3-round sequential sync: PASS`)
  })

  it('idempotent pull — pulling twice yields no duplicates', async () => {
    const chaos = new ChaosController({ seed: 8000 })
    const wrappedFetch = chaos.wrapFetch(serverFetch)

    const { devices, identities } = await createDeviceSet(2, wrappedFetch)
    const [devA, devB] = devices
    const [idA] = identities

    const taskId = crypto.randomUUID()
    await devA.createItem('task', taskId, { title: 'Idempotent test' })
    await devA.push()

    const pull1 = await devB.pull()
    expect(pull1.applied).toBe(1)

    const pull2 = await devB.pull()
    expect(pull2.applied).toBe(0)

    expect(devB.getAllItems().size).toBe(1)

    console.log(`[seed=${chaos.getSeed()}] Idempotent pull: PASS`)
  })
})
