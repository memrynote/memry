import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => {
  const keytarStore = new Map<string, string>()
  const self = {
    appReady: true,
    encryptionAvailable: true,
    backend: 'keychain_access',
    userDataDir: '',
    // encryptString prefixes the plaintext; decryptString requires decryptPrefix.
    // Diverging the two simulates a broken safeStorage round-trip.
    encryptPrefix: 'enc:',
    decryptPrefix: 'enc:',
    // Async safeStorage API (Electron 43 os_crypt_async). Present and available
    // by default so the whole suite exercises the async path; individual tests
    // flip these to cover the sync fallback. Sync and async mocks share the
    // exact same ciphertext encoding — mirroring Electron, where both APIs
    // produce and accept identical bytes.
    asyncApiPresent: true,
    asyncAvailable: true,
    shouldReEncrypt: false,
    keytarStore,
    keytarGet: vi.fn(async (s: string, a: string) => keytarStore.get(`${s}:${a}`) ?? null),
    keytarSet: vi.fn(async (s: string, a: string, v: string) => {
      keytarStore.set(`${s}:${a}`, v)
    }),
    keytarDelete: vi.fn(async (s: string, a: string) => keytarStore.delete(`${s}:${a}`)),
    decode(buf: Buffer): string {
      const raw = buf.toString('utf-8')
      if (!raw.startsWith(self.decryptPrefix)) throw new Error('safeStorage decrypt failed')
      return raw.slice(self.decryptPrefix.length)
    },
    syncEncrypt: vi.fn((value: string) => Buffer.from(`${self.encryptPrefix}${value}`, 'utf-8')),
    syncDecrypt: vi.fn((buf: Buffer) => self.decode(buf)),
    isAsyncEncryptionAvailable: vi.fn(async () => self.asyncAvailable),
    asyncEncrypt: vi.fn(async (value: string) =>
      Buffer.from(`${self.encryptPrefix}${value}`, 'utf-8')
    ),
    asyncDecrypt: vi.fn(async (buf: Buffer) => ({
      shouldReEncrypt: self.shouldReEncrypt,
      result: self.decode(buf)
    }))
  }
  return self
})

vi.mock('electron', () => ({
  app: {
    isReady: () => harness.appReady,
    getPath: (name: string) => {
      if (name !== 'userData') throw new Error(`unexpected getPath(${name})`)
      return harness.userDataDir
    }
  },
  safeStorage: {
    isEncryptionAvailable: () => harness.encryptionAvailable,
    getSelectedStorageBackend: () => harness.backend,
    encryptString: harness.syncEncrypt,
    decryptString: harness.syncDecrypt,
    // Getter-based so tests can simulate an Electron without the async API
    // surface (typeof checks in the implementation see undefined).
    get isAsyncEncryptionAvailable() {
      return harness.asyncApiPresent ? harness.isAsyncEncryptionAvailable : undefined
    },
    get encryptStringAsync() {
      return harness.asyncApiPresent ? harness.asyncEncrypt : undefined
    },
    get decryptStringAsync() {
      return harness.asyncApiPresent ? harness.asyncDecrypt : undefined
    }
  }
}))

vi.mock('keytar', () => ({
  default: {
    getPassword: harness.keytarGet,
    setPassword: harness.keytarSet,
    deletePassword: harness.keytarDelete
  }
}))

import {
  SECRET_STORE_FILENAME,
  deleteSecret,
  finalizeKeytarMigration,
  getSecret,
  isSafeStorageAvailable,
  resetSecretStorageForTests,
  setSecret
} from './secret-storage'

const SERVICE = 'com.memry.test-service'
const ACCOUNT = 'test-account'

const originalPlatform = process.platform
const setPlatform = (platform: string): void => {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

const storeFilePath = (): string => path.join(harness.userDataDir, SECRET_STORE_FILENAME)

const readStoreJson = (): { version: number; entries: Record<string, Record<string, string>> } =>
  JSON.parse(fs.readFileSync(storeFilePath(), 'utf-8'))

const cipherFor = (value: string): string => Buffer.from(`enc:${value}`, 'utf-8').toString('base64')

const seedStoreFile = (service: string, account: string, value: string): void => {
  fs.mkdirSync(harness.userDataDir, { recursive: true })
  fs.writeFileSync(
    storeFilePath(),
    JSON.stringify({ version: 1, entries: { [service]: { [account]: cipherFor(value) } } }),
    'utf-8'
  )
}

describe('secret-storage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetSecretStorageForTests()
    harness.appReady = true
    harness.encryptionAvailable = true
    harness.backend = 'keychain_access'
    harness.encryptPrefix = 'enc:'
    harness.decryptPrefix = 'enc:'
    harness.asyncApiPresent = true
    harness.asyncAvailable = true
    harness.shouldReEncrypt = false
    harness.keytarStore.clear()
    harness.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-secret-storage-'))
  })

  afterEach(() => {
    setPlatform(originalPlatform)
    fs.rmSync(harness.userDataDir, { recursive: true, force: true })
  })

  // --------------------------------------------------------------------------
  // Availability gating
  // --------------------------------------------------------------------------

  describe('isSafeStorageAvailable', () => {
    it('is false before app ready even when encryption is available', () => {
      harness.appReady = false
      expect(isSafeStorageAvailable()).toBe(false)
    })

    it('is false when safeStorage reports encryption unavailable', () => {
      harness.encryptionAvailable = false
      expect(isSafeStorageAvailable()).toBe(false)
    })

    it('refuses the plaintext basic_text backend on Linux', () => {
      setPlatform('linux')
      harness.backend = 'basic_text'
      expect(isSafeStorageAvailable()).toBe(false)
    })

    it('accepts a real keyring backend on Linux', () => {
      setPlatform('linux')
      harness.backend = 'gnome_libsecret'
      expect(isSafeStorageAvailable()).toBe(true)
    })
  })

  // --------------------------------------------------------------------------
  // Dual-read + migrate-on-read
  // --------------------------------------------------------------------------

  describe('getSecret migration', () => {
    it('migrates a keytar secret: encrypt, persist, verify, then delete from keytar', async () => {
      harness.keytarStore.set(`${SERVICE}:${ACCOUNT}`, 'legacy-value')

      const value = await getSecret(SERVICE, ACCOUNT)

      expect(value).toBe('legacy-value')
      expect(readStoreJson().entries[SERVICE][ACCOUNT]).toBe(cipherFor('legacy-value'))
      expect(harness.keytarDelete).toHaveBeenCalledWith(SERVICE, ACCOUNT)
      expect(harness.keytarStore.has(`${SERVICE}:${ACCOUNT}`)).toBe(false)
    })

    it('does not migrate when encryption is unavailable but keytar reads still work', async () => {
      harness.encryptionAvailable = false
      harness.keytarStore.set(`${SERVICE}:${ACCOUNT}`, 'legacy-value')

      const value = await getSecret(SERVICE, ACCOUNT)

      expect(value).toBe('legacy-value')
      expect(fs.existsSync(storeFilePath())).toBe(false)
      expect(harness.keytarDelete).not.toHaveBeenCalled()
    })

    it('does not migrate on the Linux basic_text backend; keytar stays authoritative', async () => {
      setPlatform('linux')
      harness.backend = 'basic_text'
      harness.keytarStore.set(`${SERVICE}:${ACCOUNT}`, 'legacy-value')

      const value = await getSecret(SERVICE, ACCOUNT)

      expect(value).toBe('legacy-value')
      expect(fs.existsSync(storeFilePath())).toBe(false)
      expect(harness.keytarDelete).not.toHaveBeenCalled()
    })

    it('keeps keytar authoritative and persists nothing when round-trip verification fails', async () => {
      harness.encryptPrefix = 'garbled:' // decrypt of persisted bytes will fail
      harness.keytarStore.set(`${SERVICE}:${ACCOUNT}`, 'legacy-value')

      const value = await getSecret(SERVICE, ACCOUNT)

      expect(value).toBe('legacy-value')
      expect(harness.keytarDelete).not.toHaveBeenCalled()
      expect(harness.keytarStore.get(`${SERVICE}:${ACCOUNT}`)).toBe('legacy-value')
      if (fs.existsSync(storeFilePath())) {
        expect(readStoreJson().entries[SERVICE]?.[ACCOUNT]).toBeUndefined()
      }
    })

    it('reads safeStorage first when both copies exist (dual-read order)', async () => {
      await setSecret(SERVICE, ACCOUNT, 'store-value')
      harness.keytarStore.set(`${SERVICE}:${ACCOUNT}`, 'keytar-value')

      await expect(getSecret(SERVICE, ACCOUNT)).resolves.toBe('store-value')
    })

    it('falls back to keytar with the identical account string when the store has no entry', async () => {
      harness.encryptionAvailable = false
      harness.keytarStore.set(`${SERVICE}:${ACCOUNT}`, 'legacy-value')

      await getSecret(SERVICE, ACCOUNT)

      expect(harness.keytarGet).toHaveBeenCalledWith(SERVICE, ACCOUNT)
    })

    it('is idempotent: repeat reads return the same value and delete from keytar only once', async () => {
      harness.keytarStore.set(`${SERVICE}:${ACCOUNT}`, 'legacy-value')

      await expect(getSecret(SERVICE, ACCOUNT)).resolves.toBe('legacy-value')
      await expect(getSecret(SERVICE, ACCOUNT)).resolves.toBe('legacy-value')
      await expect(getSecret(SERVICE, ACCOUNT)).resolves.toBe('legacy-value')

      await vi.waitFor(() => {
        expect(harness.keytarDelete).toHaveBeenCalledTimes(1)
      })
      expect(readStoreJson().entries[SERVICE][ACCOUNT]).toBe(cipherFor('legacy-value'))
    })

    it('resumes after a crash between persist and keytar delete without corruption', async () => {
      // Simulates: previous run persisted + verified the ciphertext, crashed
      // before keytar.deletePassword. Both copies exist and are identical.
      seedStoreFile(SERVICE, ACCOUNT, 'legacy-value')
      harness.keytarStore.set(`${SERVICE}:${ACCOUNT}`, 'legacy-value')

      const value = await getSecret(SERVICE, ACCOUNT)

      expect(value).toBe('legacy-value')
      await vi.waitFor(() => {
        expect(harness.keytarDelete).toHaveBeenCalledWith(SERVICE, ACCOUNT)
      })
      expect(readStoreJson().entries[SERVICE][ACCOUNT]).toBe(cipherFor('legacy-value'))
    })

    it('never deletes a keytar copy that differs from the safeStorage copy', async () => {
      seedStoreFile(SERVICE, ACCOUNT, 'store-value')
      harness.keytarStore.set(`${SERVICE}:${ACCOUNT}`, 'different-value')

      await expect(getSecret(SERVICE, ACCOUNT)).resolves.toBe('store-value')

      await vi.waitFor(() => {
        expect(harness.keytarGet).toHaveBeenCalledWith(SERVICE, ACCOUNT)
      })
      expect(harness.keytarDelete).not.toHaveBeenCalled()
      expect(harness.keytarStore.get(`${SERVICE}:${ACCOUNT}`)).toBe('different-value')
    })

    it('self-heals an unreadable stored ciphertext from the keytar fallback', async () => {
      fs.mkdirSync(harness.userDataDir, { recursive: true })
      fs.writeFileSync(
        storeFilePath(),
        JSON.stringify({ version: 1, entries: { [SERVICE]: { [ACCOUNT]: 'not-decryptable' } } }),
        'utf-8'
      )
      harness.keytarStore.set(`${SERVICE}:${ACCOUNT}`, 'legacy-value')

      const value = await getSecret(SERVICE, ACCOUNT)

      expect(value).toBe('legacy-value')
      expect(readStoreJson().entries[SERVICE][ACCOUNT]).toBe(cipherFor('legacy-value'))
    })

    it('moves an unparseable store file aside and still serves the keytar fallback', async () => {
      fs.mkdirSync(harness.userDataDir, { recursive: true })
      fs.writeFileSync(storeFilePath(), 'not json {{{', 'utf-8')
      harness.keytarStore.set(`${SERVICE}:${ACCOUNT}`, 'legacy-value')

      const value = await getSecret(SERVICE, ACCOUNT)

      expect(value).toBe('legacy-value')
      const corruptBackups = fs
        .readdirSync(harness.userDataDir)
        .filter((name) => name.includes('.corrupt-'))
      expect(corruptBackups).toHaveLength(1)
      expect(readStoreJson().entries[SERVICE][ACCOUNT]).toBe(cipherFor('legacy-value'))
    })
  })

  // --------------------------------------------------------------------------
  // Deferred migration (vault master key)
  // --------------------------------------------------------------------------

  describe('deferred keytar delete', () => {
    it('persists the migrated secret but keeps the keytar copy until finalize', async () => {
      harness.keytarStore.set(`${SERVICE}:${ACCOUNT}`, 'master-key-material')

      const value = await getSecret(SERVICE, ACCOUNT, { deferKeytarDelete: true })

      expect(value).toBe('master-key-material')
      expect(readStoreJson().entries[SERVICE][ACCOUNT]).toBe(cipherFor('master-key-material'))
      expect(harness.keytarDelete).not.toHaveBeenCalled()
      expect(harness.keytarStore.get(`${SERVICE}:${ACCOUNT}`)).toBe('master-key-material')

      await finalizeKeytarMigration(SERVICE, ACCOUNT)

      expect(harness.keytarDelete).toHaveBeenCalledWith(SERVICE, ACCOUNT)
      expect(harness.keytarStore.has(`${SERVICE}:${ACCOUNT}`)).toBe(false)
    })

    it('skips the lazy cleanup on store hits while deletion is deferred', async () => {
      seedStoreFile(SERVICE, ACCOUNT, 'master-key-material')
      harness.keytarStore.set(`${SERVICE}:${ACCOUNT}`, 'master-key-material')

      await getSecret(SERVICE, ACCOUNT, { deferKeytarDelete: true })
      await new Promise((resolve) => setImmediate(resolve))

      expect(harness.keytarDelete).not.toHaveBeenCalled()
    })

    it('finalize refuses to delete a keytar copy that differs from the stored secret', async () => {
      seedStoreFile(SERVICE, ACCOUNT, 'store-value')
      harness.keytarStore.set(`${SERVICE}:${ACCOUNT}`, 'different-value')

      await finalizeKeytarMigration(SERVICE, ACCOUNT)

      expect(harness.keytarDelete).not.toHaveBeenCalled()
    })

    it('finalize is idempotent and a no-op without a stored secret', async () => {
      await finalizeKeytarMigration(SERVICE, ACCOUNT)
      await finalizeKeytarMigration(SERVICE, ACCOUNT)
      expect(harness.keytarDelete).not.toHaveBeenCalled()
    })

    it('finalize is a no-op when safeStorage is unavailable', async () => {
      seedStoreFile(SERVICE, ACCOUNT, 'store-value')
      harness.keytarStore.set(`${SERVICE}:${ACCOUNT}`, 'store-value')
      harness.encryptionAvailable = false

      await finalizeKeytarMigration(SERVICE, ACCOUNT)

      expect(harness.keytarDelete).not.toHaveBeenCalled()
    })
  })

  // --------------------------------------------------------------------------
  // Writes
  // --------------------------------------------------------------------------

  describe('setSecret', () => {
    it('writes encrypted to the store, not keytar, and drops any stale keytar copy', async () => {
      harness.keytarStore.set(`${SERVICE}:${ACCOUNT}`, 'stale-value')

      await setSecret(SERVICE, ACCOUNT, 'new-value')

      expect(readStoreJson().entries[SERVICE][ACCOUNT]).toBe(cipherFor('new-value'))
      expect(harness.keytarSet).not.toHaveBeenCalled()
      expect(harness.keytarStore.has(`${SERVICE}:${ACCOUNT}`)).toBe(false)
      await expect(getSecret(SERVICE, ACCOUNT)).resolves.toBe('new-value')
    })

    it('writes to keytar when encryption is unavailable', async () => {
      harness.encryptionAvailable = false

      await setSecret(SERVICE, ACCOUNT, 'value')

      expect(harness.keytarSet).toHaveBeenCalledWith(SERVICE, ACCOUNT, 'value')
      expect(fs.existsSync(storeFilePath())).toBe(false)
    })

    it('falls back to keytar when the encrypted value fails round-trip verification', async () => {
      harness.encryptPrefix = 'garbled:'

      await setSecret(SERVICE, ACCOUNT, 'value')

      expect(harness.keytarSet).toHaveBeenCalledWith(SERVICE, ACCOUNT, 'value')
    })

    it('falls back to keytar when the store file cannot be persisted', async () => {
      // Point userData at a regular file so mkdir/write of the store fails.
      const blocker = path.join(harness.userDataDir, 'blocker')
      fs.writeFileSync(blocker, 'x', 'utf-8')
      harness.userDataDir = blocker

      await setSecret(SERVICE, ACCOUNT, 'value')

      expect(harness.keytarSet).toHaveBeenCalledWith(SERVICE, ACCOUNT, 'value')
    })
  })

  // --------------------------------------------------------------------------
  // Atomic writes
  // --------------------------------------------------------------------------

  describe('atomic store writes', () => {
    it('writes through a temp file and renames it over the store', async () => {
      const writeSpy = vi.spyOn(fs, 'writeFileSync')
      const renameSpy = vi.spyOn(fs, 'renameSync')

      await setSecret(SERVICE, ACCOUNT, 'value')

      const tmpWrite = writeSpy.mock.calls.find(
        ([target]) => typeof target === 'string' && target.endsWith('.tmp')
      )
      expect(tmpWrite).toBeDefined()
      const tmpPath = tmpWrite![0] as string
      expect(tmpPath).not.toBe(storeFilePath())
      expect(path.dirname(tmpPath)).toBe(path.dirname(storeFilePath()))
      expect(renameSpy).toHaveBeenCalledWith(tmpPath, storeFilePath())

      writeSpy.mockRestore()
      renameSpy.mockRestore()
    })

    it('leaves the existing store intact when a write crashes mid-rename', async () => {
      await setSecret(SERVICE, 'existing-account', 'existing-value')

      const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
        throw new Error('simulated crash during rename')
      })

      await setSecret(SERVICE, ACCOUNT, 'new-value')

      renameSpy.mockRestore()

      // Prior content survived untouched, the failed write fell back to keytar,
      // and no temp files linger.
      expect(readStoreJson().entries[SERVICE]['existing-account']).toBe(cipherFor('existing-value'))
      expect(readStoreJson().entries[SERVICE][ACCOUNT]).toBeUndefined()
      expect(harness.keytarSet).toHaveBeenCalledWith(SERVICE, ACCOUNT, 'new-value')
      const leftoverTmp = fs
        .readdirSync(harness.userDataDir)
        .filter((name) => name.endsWith('.tmp'))
      expect(leftoverTmp).toHaveLength(0)
    })
  })

  // --------------------------------------------------------------------------
  // Deletes
  // --------------------------------------------------------------------------

  describe('deleteSecret', () => {
    it('removes the secret from both the store and keytar', async () => {
      await setSecret(SERVICE, ACCOUNT, 'value')
      await setSecret(SERVICE, 'other-account', 'other-value')
      harness.keytarStore.set(`${SERVICE}:${ACCOUNT}`, 'value')

      await deleteSecret(SERVICE, ACCOUNT)

      expect(harness.keytarDelete).toHaveBeenCalledWith(SERVICE, ACCOUNT)
      expect(readStoreJson().entries[SERVICE][ACCOUNT]).toBeUndefined()
      expect(readStoreJson().entries[SERVICE]['other-account']).toBe(cipherFor('other-value'))
    })

    it('still deletes from keytar when the app is not ready', async () => {
      harness.appReady = false
      harness.keytarStore.set(`${SERVICE}:${ACCOUNT}`, 'value')

      await deleteSecret(SERVICE, ACCOUNT)

      expect(harness.keytarDelete).toHaveBeenCalledWith(SERVICE, ACCOUNT)
      expect(harness.keytarStore.has(`${SERVICE}:${ACCOUNT}`)).toBe(false)
    })
  })

  // --------------------------------------------------------------------------
  // Async safeStorage API (Electron 43 os_crypt_async)
  // --------------------------------------------------------------------------

  describe('async safeStorage API', () => {
    it('uses the async API for writes and reads; the sync API is never called', async () => {
      await setSecret(SERVICE, ACCOUNT, 'value')
      await expect(getSecret(SERVICE, ACCOUNT)).resolves.toBe('value')

      expect(harness.asyncEncrypt).toHaveBeenCalledWith('value')
      expect(harness.asyncDecrypt).toHaveBeenCalled()
      expect(harness.syncEncrypt).not.toHaveBeenCalled()
      expect(harness.syncDecrypt).not.toHaveBeenCalled()
      // Ciphertext on disk is byte-identical to what the sync API would write.
      expect(readStoreJson().entries[SERVICE][ACCOUNT]).toBe(cipherFor('value'))
    })

    it('falls back to the sync API when isAsyncEncryptionAvailable resolves false', async () => {
      harness.asyncAvailable = false

      await setSecret(SERVICE, ACCOUNT, 'value')
      await expect(getSecret(SERVICE, ACCOUNT)).resolves.toBe('value')

      expect(harness.syncEncrypt).toHaveBeenCalledWith('value')
      expect(harness.syncDecrypt).toHaveBeenCalled()
      expect(harness.asyncEncrypt).not.toHaveBeenCalled()
      expect(harness.asyncDecrypt).not.toHaveBeenCalled()
      expect(readStoreJson().entries[SERVICE][ACCOUNT]).toBe(cipherFor('value'))
    })

    it('falls back to the sync API when the async surface is absent', async () => {
      harness.asyncApiPresent = false

      await setSecret(SERVICE, ACCOUNT, 'value')
      await expect(getSecret(SERVICE, ACCOUNT)).resolves.toBe('value')

      expect(harness.syncEncrypt).toHaveBeenCalledWith('value')
      expect(harness.syncDecrypt).toHaveBeenCalled()
      expect(harness.isAsyncEncryptionAvailable).not.toHaveBeenCalled()
      expect(harness.asyncEncrypt).not.toHaveBeenCalled()
      expect(harness.asyncDecrypt).not.toHaveBeenCalled()
    })

    it('accepts sync-era ciphertext unchanged on the async read path', async () => {
      seedStoreFile(SERVICE, ACCOUNT, 'legacy-value')
      const bytesBefore = fs.readFileSync(storeFilePath(), 'utf-8')

      await expect(getSecret(SERVICE, ACCOUNT)).resolves.toBe('legacy-value')

      // The async decryptor received the stored bytes verbatim — no
      // re-encoding or transformation between the two API generations.
      const received = harness.asyncDecrypt.mock.calls[0][0]
      expect(received.equals(Buffer.from(cipherFor('legacy-value'), 'base64'))).toBe(true)
      expect(fs.readFileSync(storeFilePath(), 'utf-8')).toBe(bytesBefore)
      expect(harness.syncDecrypt).not.toHaveBeenCalled()
    })

    it('async-written ciphertext is readable by the sync path on a later run', async () => {
      await setSecret(SERVICE, ACCOUNT, 'value')
      expect(harness.asyncEncrypt).toHaveBeenCalledWith('value')
      const bytesBefore = fs.readFileSync(storeFilePath(), 'utf-8')

      // Simulate the next app run on an Electron without async encryption.
      resetSecretStorageForTests()
      harness.asyncAvailable = false
      harness.asyncDecrypt.mockClear()
      harness.syncDecrypt.mockClear()

      await expect(getSecret(SERVICE, ACCOUNT)).resolves.toBe('value')

      expect(harness.syncDecrypt).toHaveBeenCalled()
      expect(harness.asyncDecrypt).not.toHaveBeenCalled()
      expect(fs.readFileSync(storeFilePath(), 'utf-8')).toBe(bytesBefore)
    })

    it('ignores shouldReEncrypt: the read returns the value and never rewrites the store', async () => {
      harness.shouldReEncrypt = true
      seedStoreFile(SERVICE, ACCOUNT, 'value')
      const bytesBefore = fs.readFileSync(storeFilePath(), 'utf-8')

      await expect(getSecret(SERVICE, ACCOUNT)).resolves.toBe('value')

      expect(harness.asyncEncrypt).not.toHaveBeenCalled()
      expect(fs.readFileSync(storeFilePath(), 'utf-8')).toBe(bytesBefore)
    })

    it('keeps encryption-unavailable gating unchanged: the async API is never touched', async () => {
      harness.encryptionAvailable = false
      harness.keytarStore.set(`${SERVICE}:${ACCOUNT}`, 'legacy-value')

      await expect(getSecret(SERVICE, ACCOUNT)).resolves.toBe('legacy-value')
      await setSecret(SERVICE, ACCOUNT, 'new-value')

      expect(harness.keytarSet).toHaveBeenCalledWith(SERVICE, ACCOUNT, 'new-value')
      expect(fs.existsSync(storeFilePath())).toBe(false)
      expect(harness.isAsyncEncryptionAvailable).not.toHaveBeenCalled()
      expect(harness.asyncEncrypt).not.toHaveBeenCalled()
      expect(harness.asyncDecrypt).not.toHaveBeenCalled()
    })

    it('an async encryption rejection falls back to keytar exactly like a sync throw', async () => {
      harness.asyncEncrypt.mockRejectedValueOnce(new Error('os_crypt_async failure'))

      await setSecret(SERVICE, ACCOUNT, 'value')

      expect(harness.keytarSet).toHaveBeenCalledWith(SERVICE, ACCOUNT, 'value')
      if (fs.existsSync(storeFilePath())) {
        expect(readStoreJson().entries[SERVICE]?.[ACCOUNT]).toBeUndefined()
      }
    })

    it('an async decryption rejection falls back to the OS keychain copy', async () => {
      seedStoreFile(SERVICE, ACCOUNT, 'store-value')
      harness.keytarStore.set(`${SERVICE}:${ACCOUNT}`, 'legacy-value')
      harness.asyncDecrypt.mockRejectedValueOnce(new Error('os_crypt_async failure'))

      await expect(getSecret(SERVICE, ACCOUNT)).resolves.toBe('legacy-value')
    })

    it('a failed availability probe falls back to the sync API', async () => {
      harness.isAsyncEncryptionAvailable.mockRejectedValueOnce(new Error('probe failure'))

      await setSecret(SERVICE, ACCOUNT, 'value')

      expect(harness.syncEncrypt).toHaveBeenCalledWith('value')
      expect(harness.asyncEncrypt).not.toHaveBeenCalled()
      await expect(getSecret(SERVICE, ACCOUNT)).resolves.toBe('value')
    })

    it('probes async availability exactly once across concurrent startup reads', async () => {
      seedStoreFile(SERVICE, 'account-a', 'value-a')
      const store = readStoreJson()
      store.entries[SERVICE]['account-b'] = cipherFor('value-b')
      store.entries[SERVICE]['account-c'] = cipherFor('value-c')
      fs.writeFileSync(storeFilePath(), JSON.stringify(store), 'utf-8')

      const [a, b, c] = await Promise.all([
        getSecret(SERVICE, 'account-a'),
        getSecret(SERVICE, 'account-b'),
        getSecret(SERVICE, 'account-c')
      ])

      expect([a, b, c]).toEqual(['value-a', 'value-b', 'value-c'])
      expect(harness.isAsyncEncryptionAvailable).toHaveBeenCalledTimes(1)
    })
  })
})
