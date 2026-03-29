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

describe('Sync Harness — Basic Convergence', () => {
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

  it('should sync a task from device A to device B', async () => {
    const chaos = new ChaosController({ seed: 42 })
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

    const taskId = crypto.randomUUID()
    const taskContent = {
      title: 'Buy groceries',
      completed: false,
      priority: 'medium'
    }

    await deviceA.createItem('task', taskId, taskContent)
    oracle.record({
      deviceId: identityA.deviceId,
      itemId: taskId,
      type: 'task',
      fields: taskContent,
      clock: { [identityA.deviceId]: 1 },
      operation: 'create'
    })

    const pushResult = await deviceA.push()
    expect(pushResult.accepted).toContain(taskId)
    expect(pushResult.rejected).toHaveLength(0)

    const pullResult = await deviceB.pull()
    expect(pullResult.applied).toBe(1)

    const itemOnB = deviceB.getItem(taskId)
    expect(itemOnB).toBeDefined()
    expect(itemOnB!.content.title).toBe('Buy groceries')
    expect(itemOnB!.content.completed).toBe(false)
    expect(itemOnB!.content.priority).toBe('medium')

    const mismatches = oracle.compare(deviceB.getAllItems())
    expect(mismatches).toHaveLength(0)

    console.log(`[seed=${chaos.getSeed()}] Basic convergence: PASS`)
  })

  it('should sync settings from device A to device B', async () => {
    const chaos = new ChaosController({ seed: 123 })
    const wrappedFetch = chaos.wrapFetch(serverFetch)
    const oracle = new OracleModel()

    const sharedVaultKey = generateVaultKey()
    const sharedUserId = crypto.randomUUID()

    const identityA = await createTestDevice(server, {
      userId: sharedUserId,
      vaultKey: sharedVaultKey
    })
    const identityB = await createTestDevice(server, {
      userId: sharedUserId,
      vaultKey: sharedVaultKey
    })

    const deviceA = new SimulatedDevice(identityA, wrappedFetch)
    const deviceB = new SimulatedDevice(identityB, wrappedFetch)

    deviceA.registerPeerDevice(identityB.deviceId, identityB.signingPublicKey)
    deviceB.registerPeerDevice(identityA.deviceId, identityA.signingPublicKey)

    const settingsId = 'user-settings'
    const settingsContent = {
      theme: 'dark',
      fontSize: 14,
      language: 'en'
    }

    await deviceA.createItem('settings', settingsId, settingsContent)
    oracle.record({
      deviceId: identityA.deviceId,
      itemId: settingsId,
      type: 'settings',
      fields: settingsContent,
      clock: { [identityA.deviceId]: 1 },
      operation: 'create'
    })

    const pushResult = await deviceA.push()
    expect(pushResult.accepted).toContain(settingsId)

    const pullResult = await deviceB.pull()
    expect(pullResult.applied).toBe(1)

    const settingsOnB = deviceB.getItem(settingsId)
    expect(settingsOnB).toBeDefined()
    expect(settingsOnB!.content.theme).toBe('dark')
    expect(settingsOnB!.content.fontSize).toBe(14)

    const mismatches = oracle.compare(deviceB.getAllItems())
    expect(mismatches).toHaveLength(0)

    console.log(`[seed=${chaos.getSeed()}] Settings convergence: PASS`)
  })

  it('should handle multiple items from A reaching B', async () => {
    const chaos = new ChaosController({ seed: 999 })
    const wrappedFetch = chaos.wrapFetch(serverFetch)
    const oracle = new OracleModel()

    const sharedVaultKey = generateVaultKey()
    const sharedUserId = crypto.randomUUID()

    const identityA = await createTestDevice(server, {
      userId: sharedUserId,
      vaultKey: sharedVaultKey
    })
    const identityB = await createTestDevice(server, {
      userId: sharedUserId,
      vaultKey: sharedVaultKey
    })

    const deviceA = new SimulatedDevice(identityA, wrappedFetch)
    const deviceB = new SimulatedDevice(identityB, wrappedFetch)

    deviceA.registerPeerDevice(identityB.deviceId, identityB.signingPublicKey)
    deviceB.registerPeerDevice(identityA.deviceId, identityA.signingPublicKey)

    const tasks = [
      { id: crypto.randomUUID(), content: { title: 'Task 1', done: false } },
      { id: crypto.randomUUID(), content: { title: 'Task 2', done: true } },
      { id: crypto.randomUUID(), content: { title: 'Task 3', done: false } }
    ]

    for (const t of tasks) {
      await deviceA.createItem('task', t.id, t.content)
      oracle.record({
        deviceId: identityA.deviceId,
        itemId: t.id,
        type: 'task',
        fields: t.content,
        clock: { [identityA.deviceId]: 1 },
        operation: 'create'
      })
    }

    const pushResult = await deviceA.push()
    expect(pushResult.accepted).toHaveLength(3)

    const pullResult = await deviceB.pull()
    expect(pullResult.applied).toBe(3)

    for (const t of tasks) {
      const item = deviceB.getItem(t.id)
      expect(item).toBeDefined()
      expect(item!.content.title).toBe(t.content.title)
    }

    const mismatches = oracle.compare(deviceB.getAllItems())
    expect(mismatches).toHaveLength(0)

    console.log(`[seed=${chaos.getSeed()}] Multi-item convergence: PASS`)
  })

  it('should handle bidirectional sync (A→B, B→A)', async () => {
    const chaos = new ChaosController({ seed: 7777 })
    const wrappedFetch = chaos.wrapFetch(serverFetch)
    const oracle = new OracleModel()

    const sharedVaultKey = generateVaultKey()
    const sharedUserId = crypto.randomUUID()

    const identityA = await createTestDevice(server, {
      userId: sharedUserId,
      vaultKey: sharedVaultKey
    })
    const identityB = await createTestDevice(server, {
      userId: sharedUserId,
      vaultKey: sharedVaultKey
    })

    const deviceA = new SimulatedDevice(identityA, wrappedFetch)
    const deviceB = new SimulatedDevice(identityB, wrappedFetch)

    deviceA.registerPeerDevice(identityB.deviceId, identityB.signingPublicKey)
    deviceB.registerPeerDevice(identityA.deviceId, identityA.signingPublicKey)

    const taskIdA = crypto.randomUUID()
    await deviceA.createItem('task', taskIdA, { title: 'From A', source: 'a' })
    oracle.record({
      deviceId: identityA.deviceId,
      itemId: taskIdA,
      type: 'task',
      fields: { title: 'From A', source: 'a' },
      clock: { [identityA.deviceId]: 1 },
      operation: 'create'
    })

    await deviceA.push()

    const taskIdB = crypto.randomUUID()
    await deviceB.createItem('task', taskIdB, { title: 'From B', source: 'b' })
    oracle.record({
      deviceId: identityB.deviceId,
      itemId: taskIdB,
      type: 'task',
      fields: { title: 'From B', source: 'b' },
      clock: { [identityB.deviceId]: 1 },
      operation: 'create'
    })

    await deviceB.push()

    await deviceA.pull()
    await deviceB.pull()

    expect(deviceA.getItem(taskIdB)).toBeDefined()
    expect(deviceB.getItem(taskIdA)).toBeDefined()
    expect(deviceA.getItem(taskIdA)).toBeDefined()
    expect(deviceB.getItem(taskIdB)).toBeDefined()

    const mismatchesA = oracle.compare(deviceA.getAllItems())
    const mismatchesB = oracle.compare(deviceB.getAllItems())
    expect(mismatchesA).toHaveLength(0)
    expect(mismatchesB).toHaveLength(0)

    console.log(`[seed=${chaos.getSeed()}] Bidirectional convergence: PASS`)
  })
})
