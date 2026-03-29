import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { SimulatedServer } from '../src/simulated-server.js'
import { SimulatedDevice } from '../src/simulated-device.js'
import { ChaosController } from '../src/chaos-controller.js'
import { createTestDevice } from '../src/test-auth.js'
import {
  generateVaultKey,
  initCrypto,
  encryptItemForPush,
  decryptItemFromPull
} from '../src/crypto.js'
import type { DecryptFromPullInput } from '../src/crypto.js'
import type { FetchFn } from '../src/types.js'
import type { PushItem } from '@memry/contracts/sync-api'

const server = new SimulatedServer()
let serverFetch: FetchFn

function buildDecryptInput(
  pushItem: PushItem,
  identity: { vaultKey: Uint8Array; signingPublicKey: Uint8Array }
): DecryptFromPullInput {
  return {
    id: pushItem.id,
    type: pushItem.type,
    operation: pushItem.operation,
    cryptoVersion: 1,
    encryptedKey: pushItem.encryptedKey,
    keyNonce: pushItem.keyNonce,
    encryptedData: pushItem.encryptedData,
    dataNonce: pushItem.dataNonce,
    signature: pushItem.signature,
    signerDeviceId: pushItem.signerDeviceId,
    metadata: pushItem.clock ? { clock: pushItem.clock } : undefined,
    vaultKey: identity.vaultKey,
    signerPublicKey: identity.signingPublicKey
  }
}

function flipBase64Char(b64: string): string {
  const chars = b64.split('')
  const idx = Math.floor(chars.length / 2)
  const original = chars[idx]
  chars[idx] = original === 'A' ? 'B' : 'A'
  return chars.join('')
}

describe('Sync Harness — Negative Crypto', () => {
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

  it('wrong vault key on decrypt should throw', async () => {
    // #given
    const chaos = new ChaosController({ seed: 10001 })
    const wrappedFetch = chaos.wrapFetch(serverFetch)

    const sharedUserId = crypto.randomUUID()
    const vaultKeyA = generateVaultKey()
    const vaultKeyB = generateVaultKey()

    const identityA = await createTestDevice(server, {
      userId: sharedUserId,
      deviceName: 'device-a',
      vaultKey: vaultKeyA
    })
    const identityB = await createTestDevice(server, {
      userId: sharedUserId,
      deviceName: 'device-b',
      vaultKey: vaultKeyB
    })

    const deviceA = new SimulatedDevice(identityA, wrappedFetch)
    const deviceB = new SimulatedDevice(identityB, wrappedFetch)

    deviceA.registerPeerDevice(identityB.deviceId, identityB.signingPublicKey)
    deviceB.registerPeerDevice(identityA.deviceId, identityA.signingPublicKey)

    // #when
    const taskId = crypto.randomUUID()
    await deviceA.createItem('task', taskId, { title: 'Secret task' })
    await deviceA.push()

    // #then — device B has a different vault key so decryption should fail
    await expect(deviceB.pull()).rejects.toThrow()
  })

  it('corrupted signature should throw', async () => {
    // #given
    const chaos = new ChaosController({ seed: 10002 })
    const wrappedFetch = chaos.wrapFetch(serverFetch)

    const sharedVaultKey = generateVaultKey()
    const sharedUserId = crypto.randomUUID()

    const identityA = await createTestDevice(server, {
      userId: sharedUserId,
      vaultKey: sharedVaultKey
    })

    const deviceA = new SimulatedDevice(identityA, wrappedFetch)

    const taskId = crypto.randomUUID()
    const content = { title: 'Signed task' }
    const contentBytes = new TextEncoder().encode(JSON.stringify(content))

    await deviceA.createItem('task', taskId, content)
    await deviceA.push()

    // #when — encrypt the same content to get raw fields, then tamper with signature
    const { pushItem } = encryptItemForPush({
      id: taskId,
      type: 'task',
      operation: 'create',
      content: contentBytes,
      vaultKey: identityA.vaultKey,
      signingSecretKey: identityA.signingSecretKey,
      signerDeviceId: identityA.deviceId,
      clock: { [identityA.deviceId]: 1 }
    })

    const tamperedSignature = flipBase64Char(pushItem.signature)
    const decryptInput = buildDecryptInput(pushItem, identityA)

    // #then
    expect(() => decryptItemFromPull({ ...decryptInput, signature: tamperedSignature })).toThrow()
  })

  it('tampered encryptedData should fail decryption', async () => {
    // #given
    const chaos = new ChaosController({ seed: 10003 })
    const wrappedFetch = chaos.wrapFetch(serverFetch)

    const sharedVaultKey = generateVaultKey()
    const sharedUserId = crypto.randomUUID()

    const identityA = await createTestDevice(server, {
      userId: sharedUserId,
      vaultKey: sharedVaultKey
    })

    const deviceA = new SimulatedDevice(identityA, wrappedFetch)

    const taskId = crypto.randomUUID()
    const content = { title: 'Tamper-proof task' }
    const contentBytes = new TextEncoder().encode(JSON.stringify(content))

    await deviceA.createItem('task', taskId, content)
    await deviceA.push()

    // #when — encrypt to get raw fields, then tamper with encryptedData
    const { pushItem } = encryptItemForPush({
      id: taskId,
      type: 'task',
      operation: 'create',
      content: contentBytes,
      vaultKey: identityA.vaultKey,
      signingSecretKey: identityA.signingSecretKey,
      signerDeviceId: identityA.deviceId,
      clock: { [identityA.deviceId]: 1 }
    })

    const tamperedData = flipBase64Char(pushItem.encryptedData)
    const decryptInput = buildDecryptInput(pushItem, identityA)

    // #then — signature check uses original encryptedData in CBOR, so tampered data
    // will cause signature verification to fail first (since encryptedData is part of
    // the signed payload). If signature somehow passes, AEAD decryption will fail.
    expect(() => decryptItemFromPull({ ...decryptInput, encryptedData: tamperedData })).toThrow()
  })

  it('expired/invalid JWT should be rejected by server', async () => {
    // #given
    const chaos = new ChaosController({ seed: 10004 })
    const wrappedFetch = chaos.wrapFetch(serverFetch)

    const sharedVaultKey = generateVaultKey()
    const sharedUserId = crypto.randomUUID()

    const identityA = await createTestDevice(server, {
      userId: sharedUserId,
      vaultKey: sharedVaultKey
    })

    const deviceA = new SimulatedDevice(identityA, wrappedFetch)
    const taskId = crypto.randomUUID()
    await deviceA.createItem('task', taskId, { title: 'Unauthorized' })
    await deviceA.push()

    // #when — raw fetch with garbage auth header
    // Miniflare may throw instead of returning 401 for malformed JWTs
    let rejected = false
    try {
      const response = await serverFetch('http://localhost/sync/push', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer garbage.invalid.token'
        },
        body: JSON.stringify({ items: [] })
      })
      rejected = response.status === 401 || response.status === 403
    } catch {
      rejected = true
    }

    // #then
    expect(rejected).toBe(true)
  })

  it('push with wrong user device should be rejected (user isolation)', async () => {
    // #given
    const chaos = new ChaosController({ seed: 10005 })
    const wrappedFetch = chaos.wrapFetch(serverFetch)

    const userIdA = crypto.randomUUID()
    const userIdB = crypto.randomUUID()
    const vaultKeyA = generateVaultKey()
    const vaultKeyB = generateVaultKey()

    const identityA = await createTestDevice(server, {
      userId: userIdA,
      deviceName: 'user-a-device',
      vaultKey: vaultKeyA
    })
    const identityB = await createTestDevice(server, {
      userId: userIdB,
      deviceName: 'user-b-device',
      vaultKey: vaultKeyB
    })

    const deviceA = new SimulatedDevice(identityA, wrappedFetch)
    const deviceB = new SimulatedDevice(identityB, wrappedFetch)

    // #when — user A pushes, user B pulls
    const taskId = crypto.randomUUID()
    await deviceA.createItem('task', taskId, { title: 'Private to user A' })
    await deviceA.push()

    const pullResult = await deviceB.pull()

    // #then — user B should see 0 items (complete user isolation)
    expect(pullResult.applied).toBe(0)
    expect(pullResult.items).toHaveLength(0)
  })
})
