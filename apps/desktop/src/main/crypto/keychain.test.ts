import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import sodium from 'libsodium-wrappers-sumo'
import keytar from 'keytar'

import { KEYCHAIN_ENTRIES } from '@memry/contracts/crypto'
import type { KeychainEntry } from '@memry/contracts/crypto'

import { deleteKey, retrieveKey, storeKey } from './keychain'

vi.mock('keytar', () => ({
  default: {
    setPassword: vi.fn(),
    getPassword: vi.fn(),
    deletePassword: vi.fn()
  }
}))

const MASTER = KEYCHAIN_ENTRIES.MASTER_KEY
const SIGNING = KEYCHAIN_ENTRIES.DEVICE_SIGNING_KEY

const toB64 = (bytes: Uint8Array): string =>
  sodium.to_base64(bytes, sodium.base64_variants.ORIGINAL)

describe('keychain', () => {
  beforeAll(async () => {
    await sodium.ready
  })

  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.MEMRY_DEVICE
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env.MEMRY_DEVICE
  })

  // --------------------------------------------------------------------------
  // storeKey
  // --------------------------------------------------------------------------

  describe('storeKey', () => {
    it('encodes key as base64 and forwards service + account to keytar', async () => {
      // #given
      const key = new Uint8Array([1, 2, 3, 4, 5])

      // #when
      await storeKey(MASTER, key)

      // #then
      expect(keytar.setPassword).toHaveBeenCalledTimes(1)
      expect(keytar.setPassword).toHaveBeenCalledWith(MASTER.service, MASTER.account, toB64(key))
    })

    it('roundtrips an empty key (boundary case)', async () => {
      // #given
      const key = new Uint8Array(0)

      // #when
      await storeKey(MASTER, key)

      // #then
      expect(keytar.setPassword).toHaveBeenCalledWith(MASTER.service, MASTER.account, toB64(key))
    })

    it('appends MEMRY_DEVICE suffix to account when env var is set', async () => {
      // #given
      process.env.MEMRY_DEVICE = 'devA'
      const key = new Uint8Array([9, 9, 9])

      // #when
      await storeKey(SIGNING, key)

      // #then
      expect(keytar.setPassword).toHaveBeenCalledWith(
        SIGNING.service,
        `${SIGNING.account}-devA`,
        toB64(key)
      )
    })

    it('wraps keytar errors with account context (Error instance)', async () => {
      // #given
      vi.mocked(keytar.setPassword).mockRejectedValueOnce(new Error('kc-write-denied'))

      // #when / #then
      await expect(storeKey(MASTER, new Uint8Array([1]))).rejects.toThrow(
        `Failed to store key in keychain (${MASTER.account}): kc-write-denied`
      )
    })

    it('wraps non-Error throwables with "unknown error" fallback', async () => {
      // #given
      vi.mocked(keytar.setPassword).mockRejectedValueOnce('string-rejection')

      // #when / #then
      await expect(storeKey(MASTER, new Uint8Array([1]))).rejects.toThrow(
        `Failed to store key in keychain (${MASTER.account}): unknown error`
      )
    })
  })

  // --------------------------------------------------------------------------
  // retrieveKey
  // --------------------------------------------------------------------------

  describe('retrieveKey', () => {
    it('decodes base64 keytar payload back to original Uint8Array', async () => {
      // #given
      const original = new Uint8Array([10, 20, 30, 40])
      vi.mocked(keytar.getPassword).mockResolvedValueOnce(toB64(original))

      // #when
      const restored = await retrieveKey(MASTER)

      // #then
      expect(keytar.getPassword).toHaveBeenCalledWith(MASTER.service, MASTER.account)
      expect(restored).toEqual(original)
    })

    it('returns null when keytar reports no entry', async () => {
      // #given
      vi.mocked(keytar.getPassword).mockResolvedValueOnce(null)

      // #when
      const result = await retrieveKey(MASTER)

      // #then
      expect(result).toBeNull()
    })

    it('returns null when keytar returns empty string (falsy guard)', async () => {
      // #given
      vi.mocked(keytar.getPassword).mockResolvedValueOnce('')

      // #when
      const result = await retrieveKey(MASTER)

      // #then
      expect(result).toBeNull()
    })

    it('uses suffixed account when MEMRY_DEVICE is set', async () => {
      // #given
      process.env.MEMRY_DEVICE = 'devB'
      vi.mocked(keytar.getPassword).mockResolvedValueOnce(null)

      // #when
      await retrieveKey(SIGNING)

      // #then
      expect(keytar.getPassword).toHaveBeenCalledWith(SIGNING.service, `${SIGNING.account}-devB`)
    })

    it('wraps keytar errors with account context (Error instance)', async () => {
      // #given
      vi.mocked(keytar.getPassword).mockRejectedValueOnce(new Error('kc-read-denied'))

      // #when / #then
      await expect(retrieveKey(MASTER)).rejects.toThrow(
        `Failed to retrieve key from keychain (${MASTER.account}): kc-read-denied`
      )
    })

    it('wraps non-Error throwables with "unknown error" fallback', async () => {
      // #given
      vi.mocked(keytar.getPassword).mockRejectedValueOnce({ code: 'ENOENT' })

      // #when / #then
      await expect(retrieveKey(MASTER)).rejects.toThrow(
        `Failed to retrieve key from keychain (${MASTER.account}): unknown error`
      )
    })
  })

  // --------------------------------------------------------------------------
  // deleteKey
  // --------------------------------------------------------------------------

  describe('deleteKey', () => {
    it('forwards service + account to keytar.deletePassword', async () => {
      // #given
      vi.mocked(keytar.deletePassword).mockResolvedValueOnce(true)

      // #when
      await deleteKey(MASTER)

      // #then
      expect(keytar.deletePassword).toHaveBeenCalledWith(MASTER.service, MASTER.account)
    })

    it('is idempotent when entry is missing (keytar returns false)', async () => {
      // #given
      vi.mocked(keytar.deletePassword).mockResolvedValueOnce(false)

      // #when / #then — no throw, no error wrapping
      await expect(deleteKey(MASTER)).resolves.toBeUndefined()
    })

    it('uses suffixed account when MEMRY_DEVICE is set', async () => {
      // #given
      process.env.MEMRY_DEVICE = 'devC'
      vi.mocked(keytar.deletePassword).mockResolvedValueOnce(true)

      // #when
      await deleteKey(SIGNING)

      // #then
      expect(keytar.deletePassword).toHaveBeenCalledWith(SIGNING.service, `${SIGNING.account}-devC`)
    })

    it('wraps keytar errors with account context (Error instance)', async () => {
      // #given
      vi.mocked(keytar.deletePassword).mockRejectedValueOnce(new Error('kc-delete-denied'))

      // #when / #then
      await expect(deleteKey(MASTER)).rejects.toThrow(
        `Failed to delete key from keychain (${MASTER.account}): kc-delete-denied`
      )
    })

    it('wraps non-Error throwables with "unknown error" fallback', async () => {
      // #given
      vi.mocked(keytar.deletePassword).mockRejectedValueOnce(42)

      // #when / #then
      await expect(deleteKey(MASTER)).rejects.toThrow(
        `Failed to delete key from keychain (${MASTER.account}): unknown error`
      )
    })
  })

  // --------------------------------------------------------------------------
  // store ↔ retrieve roundtrip (mocked)
  // --------------------------------------------------------------------------

  describe('store + retrieve roundtrip', () => {
    it('preserves bytes through base64 encode/decode against mocked storage', async () => {
      // #given — capture the encoded value written to keytar, then replay it
      const key = sodium.randombytes_buf(32)
      let stored: string | null = null
      vi.mocked(keytar.setPassword).mockImplementationOnce(async (_svc, _acct, value) => {
        stored = value
      })
      vi.mocked(keytar.getPassword).mockImplementationOnce(async () => stored)

      // #when
      await storeKey(MASTER, key)
      const restored = await retrieveKey(MASTER)

      // #then
      expect(restored).toEqual(key)
    })

    it('preserves bytes across all KEYCHAIN_ENTRIES service/account pairs', async () => {
      // #given
      const entries: KeychainEntry[] = Object.values(KEYCHAIN_ENTRIES)

      // #when / #then
      for (const entry of entries) {
        const key = sodium.randombytes_buf(16)
        let stored: string | null = null
        vi.mocked(keytar.setPassword).mockImplementationOnce(async (_svc, _acct, value) => {
          stored = value
        })
        vi.mocked(keytar.getPassword).mockImplementationOnce(async () => stored)

        await storeKey(entry, key)
        const restored = await retrieveKey(entry)

        expect(restored).toEqual(key)
      }
    })
  })
})
