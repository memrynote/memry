import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import sodium from 'libsodium-wrappers-sumo'
import { createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { syncDevices } from '@shared/db/schema/sync-devices'
import { getDeviceSigningKey, fetchAndCacheDeviceKeys } from './device-keys'

vi.mock('./http-client', () => ({
  getFromServer: vi.fn(),
  getSyncServerUrl: vi.fn().mockReturnValue('http://localhost:8787')
}))

let testDb: TestDatabaseResult

beforeEach(async () => {
  await sodium.ready
  testDb = createTestDataDb()
  vi.clearAllMocks()
})

afterEach(() => {
  testDb.close()
})

function makeBase64Key(): string {
  const key = sodium.crypto_sign_keypair().publicKey
  return sodium.to_base64(key, sodium.base64_variants.ORIGINAL)
}

describe('getDeviceSigningKey', () => {
  describe('#given device key cached in DB #when called', () => {
    it('#then returns key from DB without server fetch', async () => {
      const pubKeyBase64 = makeBase64Key()
      testDb.db
        .insert(syncDevices)
        .values({
          id: 'device-a',
          name: 'Test Device',
          platform: 'macos',
          appVersion: '1.0.0',
          linkedAt: new Date(),
          isCurrentDevice: false,
          signingPublicKey: pubKeyBase64
        })
        .run()

      const { getFromServer } = await import('./http-client')

      const result = await getDeviceSigningKey(testDb.db, 'device-a', 'test-token')

      expect(result).toBeInstanceOf(Uint8Array)
      expect(result).toHaveLength(32)
      expect(getFromServer).not.toHaveBeenCalled()
    })
  })

  describe('#given device not in DB #when called', () => {
    it('#then fetches from server and caches', async () => {
      const pubKeyBase64 = makeBase64Key()

      const { getFromServer } = await import('./http-client')
      vi.mocked(getFromServer).mockResolvedValue({
        devices: [
          {
            id: 'device-remote',
            name: 'Remote Device',
            platform: 'windows',
            signingPublicKey: pubKeyBase64,
            revokedAt: null
          }
        ]
      })

      const result = await getDeviceSigningKey(testDb.db, 'device-remote', 'test-token')

      expect(result).toBeInstanceOf(Uint8Array)
      expect(result).toHaveLength(32)
      expect(getFromServer).toHaveBeenCalledWith('/auth/devices', 'test-token')

      const row = testDb.db.select().from(syncDevices).get()
      expect(row?.signingPublicKey).toBe(pubKeyBase64)
    })
  })

  describe('#given device not found even after server fetch #when called', () => {
    it('#then returns null', async () => {
      const { getFromServer } = await import('./http-client')
      vi.mocked(getFromServer).mockResolvedValue({ devices: [] })

      const result = await getDeviceSigningKey(testDb.db, 'nonexistent', 'test-token')

      expect(result).toBeNull()
    })
  })
})

describe('fetchAndCacheDeviceKeys', () => {
  describe('#given valid server response #when called', () => {
    it('#then upserts all devices', async () => {
      const keyA = makeBase64Key()
      const keyB = makeBase64Key()

      testDb.db
        .insert(syncDevices)
        .values({
          id: 'device-a',
          name: 'Old Name',
          platform: 'macos',
          appVersion: '1.0.0',
          linkedAt: new Date(),
          isCurrentDevice: true,
          signingPublicKey: null
        })
        .run()

      const { getFromServer } = await import('./http-client')
      vi.mocked(getFromServer).mockResolvedValue({
        devices: [
          {
            id: 'device-a',
            name: 'Device A',
            platform: 'macos',
            signingPublicKey: keyA,
            revokedAt: null
          },
          {
            id: 'device-b',
            name: 'Device B',
            platform: 'windows',
            signingPublicKey: keyB,
            revokedAt: null
          }
        ]
      })

      await fetchAndCacheDeviceKeys(testDb.db, 'test-token')

      const rows = testDb.db.select().from(syncDevices).all()
      expect(rows).toHaveLength(2)

      const deviceA = rows.find((r) => r.id === 'device-a')
      expect(deviceA?.signingPublicKey).toBe(keyA)
      expect(deviceA?.isCurrentDevice).toBe(true)

      const deviceB = rows.find((r) => r.id === 'device-b')
      expect(deviceB?.signingPublicKey).toBe(keyB)
    })
  })

  describe('#given invalid server response #when called', () => {
    it('#then does not crash', async () => {
      const { getFromServer } = await import('./http-client')
      vi.mocked(getFromServer).mockResolvedValue({ invalid: true })

      await expect(fetchAndCacheDeviceKeys(testDb.db, 'test-token')).resolves.toBeUndefined()
    })
  })
})
