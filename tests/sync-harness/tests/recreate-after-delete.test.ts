import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { SimulatedServer } from '../src/simulated-server.js'
import { SimulatedDevice } from '../src/simulated-device.js'
import { createTestDevice } from '../src/test-auth.js'
import { generateVaultKey, initCrypto } from '../src/crypto.js'

// #2409: the real Worker on Miniflare D1. A device deletes a journal day and a
// tag, then re-creates both inside retention. The re-create is seeded from the
// tombstone clock, so the server accepts it through the ordinary §5.8 rule (no
// purged-marker allowance: nothing is purged yet) and the peer converges on it.

const server = new SimulatedServer()

async function createPair() {
  const vaultKey = generateVaultKey()
  const userId = crypto.randomUUID()
  const identityA = await createTestDevice(server, { userId, deviceName: 'device-a', vaultKey })
  const identityB = await createTestDevice(server, { userId, deviceName: 'device-b', vaultKey })
  const fetchFn = (input: RequestInfo | URL, init?: RequestInit) => server.fetch(input, init)
  const deviceA = new SimulatedDevice(identityA, fetchFn)
  const deviceB = new SimulatedDevice(identityB, fetchFn)
  deviceA.registerPeerDevice(identityB.deviceId, identityB.signingPublicKey)
  deviceB.registerPeerDevice(identityA.deviceId, identityA.signingPublicKey)
  return { deviceA, deviceB }
}

describe('Sync Harness — re-create after delete (#2409)', () => {
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

  it('a journal day and a tag re-created inside retention reach the other device', async () => {
    const { deviceA, deviceB } = await createPair()
    const journal = await deviceA.createItem('journal', 'j2026-04-16', { date: '2026-04-16' })
    const tag = await deviceA.createItem('tag_definition', 'work', { name: 'work', color: 'red' })
    expect((await deviceA.push([journal, tag])).accepted).toEqual(['j2026-04-16', 'work'])
    await deviceB.pull()

    const deletes = [await deviceA.deleteItem('j2026-04-16'), await deviceA.deleteItem('work')]
    expect((await deviceA.push(deletes)).accepted).toEqual(['j2026-04-16', 'work'])
    await deviceB.pull()
    expect(deviceB.getItem('j2026-04-16')).toBeUndefined()

    const recreated = [
      await deviceA.createItem('journal', 'j2026-04-16', { date: '2026-04-16', mood: 'calm' }),
      await deviceA.createItem('tag_definition', 'work', { name: 'work', color: 'blue' })
    ]
    const res = await deviceA.push(recreated)

    expect(res.rejected).toEqual([])
    expect(res.accepted).toEqual(['j2026-04-16', 'work'])
    await deviceB.pull()
    expect(deviceB.getItem('j2026-04-16')?.content).toEqual({ date: '2026-04-16', mood: 'calm' })
    expect(deviceB.getItem('work')?.content).toEqual({ name: 'work', color: 'blue' })
    expect(deviceB.getItem('work')?.clock).toEqual(recreated[1].clock)
  })

  it('an unseeded re-create of the same id is refused per item inside retention', async () => {
    const { deviceA } = await createPair()
    const tag = await deviceA.createItem('tag_definition', 'work', { name: 'work', color: 'red' })
    await deviceA.push([tag])
    await deviceA.push([await deviceA.deleteItem('work')])

    const res = await deviceA.push([{ ...tag, content: { name: 'work', color: 'blue' } }])

    expect(res.accepted).toEqual([])
    expect(res.rejected).toEqual([{ id: 'work', reason: 'SYNC_REPLAY_DETECTED' }])
  })
})
