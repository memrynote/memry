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

async function createPair(wrappedFetch: FetchFn) {
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

  return { deviceA, deviceB, identityA, identityB }
}

describe('Sync Harness — Edge Cases', () => {
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

  it('empty content — sync item with no fields', async () => {
    const chaos = new ChaosController({ seed: 9000 })
    const wrappedFetch = chaos.wrapFetch(serverFetch)
    const { deviceA, deviceB } = await createPair(wrappedFetch)

    const taskId = crypto.randomUUID()
    await deviceA.createItem('task', taskId, {})
    await deviceA.push()
    await deviceB.pull()

    const item = deviceB.getItem(taskId)
    expect(item).toBeDefined()
    expect(Object.keys(item!.content)).toHaveLength(0)

    console.log(`[seed=${chaos.getSeed()}] Empty content sync: PASS`)
  })

  it('large payload — item with 10KB of content', async () => {
    const chaos = new ChaosController({ seed: 9100 })
    const wrappedFetch = chaos.wrapFetch(serverFetch)
    const { deviceA, deviceB } = await createPair(wrappedFetch)

    const bigContent: Record<string, unknown> = {
      title: 'Large item',
      body: 'x'.repeat(10_000),
      tags: Array.from({ length: 100 }, (_, i) => `tag-${i}`)
    }

    const taskId = crypto.randomUUID()
    await deviceA.createItem('task', taskId, bigContent)
    await deviceA.push()
    await deviceB.pull()

    const item = deviceB.getItem(taskId)
    expect(item).toBeDefined()
    expect(item!.content.title).toBe('Large item')
    expect((item!.content.body as string).length).toBe(10_000)
    expect((item!.content.tags as string[]).length).toBe(100)

    console.log(`[seed=${chaos.getSeed()}] Large payload (10KB): PASS`)
  })

  it('unicode content — emoji, CJK, RTL text survives round-trip', async () => {
    const chaos = new ChaosController({ seed: 9200 })
    const wrappedFetch = chaos.wrapFetch(serverFetch)
    const { deviceA, deviceB } = await createPair(wrappedFetch)

    const content = {
      title: '🚀 Görev başlığı — タスク — مهمة',
      description: '日本語テスト 한국어 العربية Ñoño 🎉🎊🎈',
      emoji: '💡'
    }

    const taskId = crypto.randomUUID()
    await deviceA.createItem('task', taskId, content)
    await deviceA.push()
    await deviceB.pull()

    const item = deviceB.getItem(taskId)
    expect(item).toBeDefined()
    expect(item!.content.title).toBe(content.title)
    expect(item!.content.description).toBe(content.description)
    expect(item!.content.emoji).toBe('💡')

    console.log(`[seed=${chaos.getSeed()}] Unicode round-trip: PASS`)
  })

  it('rapid-fire updates — 20 updates to same item, only final state syncs', async () => {
    const chaos = new ChaosController({ seed: 9300 })
    const wrappedFetch = chaos.wrapFetch(serverFetch)
    const { deviceA, deviceB } = await createPair(wrappedFetch)

    const taskId = crypto.randomUUID()
    await deviceA.createItem('task', taskId, { counter: 0 })

    for (let i = 1; i <= 20; i++) {
      await deviceA.updateItem(taskId, { counter: i, lastUpdate: `update-${i}` })
    }

    await deviceA.push()
    await deviceB.pull()

    const item = deviceB.getItem(taskId)
    expect(item).toBeDefined()
    expect(item!.content.counter).toBe(20)
    expect(item!.content.lastUpdate).toBe('update-20')

    console.log(`[seed=${chaos.getSeed()}] 20 rapid-fire updates: PASS`)
  })

  it('nested objects — complex JSON structure preserved', async () => {
    const chaos = new ChaosController({ seed: 9400 })
    const wrappedFetch = chaos.wrapFetch(serverFetch)
    const { deviceA, deviceB } = await createPair(wrappedFetch)

    const content = {
      title: 'Complex item',
      metadata: {
        created: '2026-03-27',
        author: { name: 'Kaan', role: 'admin' },
        tags: ['urgent', 'sync']
      },
      repeat: {
        frequency: 'weekly',
        days: [1, 3, 5],
        exceptions: [{ date: '2026-04-01', reason: 'holiday' }]
      }
    }

    const taskId = crypto.randomUUID()
    await deviceA.createItem('task', taskId, content)
    await deviceA.push()
    await deviceB.pull()

    const item = deviceB.getItem(taskId)
    expect(item).toBeDefined()
    expect(item!.content).toEqual(content)

    console.log(`[seed=${chaos.getSeed()}] Nested JSON round-trip: PASS`)
  })

  it('null and boolean values survive round-trip', async () => {
    const chaos = new ChaosController({ seed: 9500 })
    const wrappedFetch = chaos.wrapFetch(serverFetch)
    const { deviceA, deviceB } = await createPair(wrappedFetch)

    const content = {
      title: 'Nullable fields',
      dueDate: null,
      completed: false,
      archived: true,
      priority: 0,
      description: ''
    }

    const taskId = crypto.randomUUID()
    await deviceA.createItem('task', taskId, content)
    await deviceA.push()
    await deviceB.pull()

    const item = deviceB.getItem(taskId)
    expect(item).toBeDefined()
    expect(item!.content.dueDate).toBeNull()
    expect(item!.content.completed).toBe(false)
    expect(item!.content.archived).toBe(true)
    expect(item!.content.priority).toBe(0)
    expect(item!.content.description).toBe('')

    console.log(`[seed=${chaos.getSeed()}] Null/boolean/falsy round-trip: PASS`)
  })

  it("separate users cannot see each other's items", async () => {
    const chaos = new ChaosController({ seed: 9600 })
    const wrappedFetch = chaos.wrapFetch(serverFetch)

    const identityAlice = await createTestDevice(server, { deviceName: 'alice-phone' })
    const identityBob = await createTestDevice(server, { deviceName: 'bob-laptop' })

    const alice = new SimulatedDevice(identityAlice, wrappedFetch)
    const bob = new SimulatedDevice(identityBob, wrappedFetch)

    const aliceTask = crypto.randomUUID()
    await alice.createItem('task', aliceTask, { title: 'Alice secret' })
    await alice.push()

    const bobTask = crypto.randomUUID()
    await bob.createItem('task', bobTask, { title: 'Bob secret' })
    await bob.push()

    await alice.pull()
    await bob.pull()

    expect(alice.getItem(bobTask)).toBeUndefined()
    expect(bob.getItem(aliceTask)).toBeUndefined()

    expect(alice.getAllItems().size).toBe(1)
    expect(bob.getAllItems().size).toBe(1)

    console.log(`[seed=${chaos.getSeed()}] User isolation: PASS`)
  })

  it('push with no items is a no-op', async () => {
    const chaos = new ChaosController({ seed: 9700 })
    const wrappedFetch = chaos.wrapFetch(serverFetch)
    const { deviceA } = await createPair(wrappedFetch)

    const result = await deviceA.push()
    expect(result.accepted).toHaveLength(0)
    expect(result.rejected).toHaveLength(0)

    console.log(`[seed=${chaos.getSeed()}] Empty push no-op: PASS`)
  })

  it('pull with no server data returns zero items', async () => {
    const chaos = new ChaosController({ seed: 9800 })
    const wrappedFetch = chaos.wrapFetch(serverFetch)
    const { deviceA } = await createPair(wrappedFetch)

    const result = await deviceA.pull()
    expect(result.applied).toBe(0)
    expect(result.items).toHaveLength(0)

    console.log(`[seed=${chaos.getSeed()}] Empty pull: PASS`)
  })
})
