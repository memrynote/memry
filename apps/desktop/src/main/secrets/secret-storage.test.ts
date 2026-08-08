import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => {
  const keytarStore = new Map<string, string>()
  return {
    appReady: true,
    encryptionAvailable: true,
    backend: 'keychain_access',
    userDataDir: '',
    // encryptString prefixes the plaintext; decryptString requires decryptPrefix.
    // Diverging the two simulates a broken safeStorage round-trip.
    encryptPrefix: 'enc:',
    decryptPrefix: 'enc:',
    keytarStore,
    keytarGet: vi.fn(async (s: string, a: string) => keytarStore.get(`${s}:${a}`) ?? null),
    keytarSet: vi.fn(async (s: string, a: string, v: string) => {
      keytarStore.set(`${s}:${a}`, v)
    }),
    keytarDelete: vi.fn(async (s: string, a: string) => keytarStore.delete(`${s}:${a}`))
  }
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
    encryptString: (value: string) => Buffer.from(`${harness.encryptPrefix}${value}`, 'utf-8'),
    decryptString: (buf: Buffer) => {
      const raw = buf.toString('utf-8')
      if (!raw.startsWith(harness.decryptPrefix)) throw new Error('safeStorage decrypt failed')
      return raw.slice(harness.decryptPrefix.length)
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

  // --------------------------------------------------------------------------
  // False-absent protection (#772 vault-orphaning guard)
  // --------------------------------------------------------------------------

  describe('false-absent protection', () => {
    it('throws instead of reporting absent when the secret exists in the store but safeStorage is unavailable this run', async () => {
      // A migrated secret lives only in safeStorage (keytar copy already
      // dropped). On a run where safeStorage cannot be read, returning null
      // would be a false absence — the master-key path would regenerate a key
      // and orphan the vault. Must fail loud instead.
      await setSecret(SERVICE, ACCOUNT, 'store-value')
      harness.keytarStore.clear()
      harness.encryptionAvailable = false

      await expect(getSecret(SERVICE, ACCOUNT)).rejects.toThrow(/could not be read this run/)
    })

    it('throws when the stored ciphertext is undecryptable and no keytar copy remains', async () => {
      fs.mkdirSync(harness.userDataDir, { recursive: true })
      fs.writeFileSync(
        storeFilePath(),
        JSON.stringify({ version: 1, entries: { [SERVICE]: { [ACCOUNT]: 'not-decryptable' } } }),
        'utf-8'
      )
      harness.keytarStore.clear()

      await expect(getSecret(SERVICE, ACCOUNT)).rejects.toThrow(/could not be read this run/)
    })

    it('still returns null for a genuinely fresh secret (nothing in store or keytar)', async () => {
      await expect(getSecret(SERVICE, ACCOUNT)).resolves.toBeNull()
    })

    it('returns null (true absence) when the store is readable and the entry is simply not there', async () => {
      seedStoreFile(SERVICE, 'other-account', 'other-value')

      await expect(getSecret(SERVICE, ACCOUNT)).resolves.toBeNull()
    })
  })

  describe('treatUnreadableAsAbsent opt-in', () => {
    const seedUndecryptable = (): void => {
      fs.mkdirSync(harness.userDataDir, { recursive: true })
      fs.writeFileSync(
        storeFilePath(),
        JSON.stringify({ version: 1, entries: { [SERVICE]: { [ACCOUNT]: 'not-decryptable' } } }),
        'utf-8'
      )
      harness.keytarStore.clear()
    }

    it('returns null instead of throwing for a caller that is about to overwrite', async () => {
      seedUndecryptable()

      await expect(
        getSecret(SERVICE, ACCOUNT, { treatUnreadableAsAbsent: true })
      ).resolves.toBeNull()
    })

    it('also covers the safeStorage-unavailable-this-run shape', async () => {
      await setSecret(SERVICE, ACCOUNT, 'store-value')
      harness.keytarStore.clear()
      harness.encryptionAvailable = false

      await expect(
        getSecret(SERVICE, ACCOUNT, { treatUnreadableAsAbsent: true })
      ).resolves.toBeNull()
    })

    it('lets the caller heal the entry by writing over it', async () => {
      seedUndecryptable()

      expect(await getSecret(SERVICE, ACCOUNT, { treatUnreadableAsAbsent: true })).toBeNull()
      await setSecret(SERVICE, ACCOUNT, 'healed-value')

      await expect(getSecret(SERVICE, ACCOUNT)).resolves.toBe('healed-value')
    })

    it('leaves the guard armed for every caller that does not opt in', async () => {
      // The master-key path must keep throwing: a false absence there
      // regenerates the vault key and orphans the encrypted data (#772).
      seedUndecryptable()

      await expect(getSecret(SERVICE, ACCOUNT)).rejects.toThrow(/could not be read this run/)
      await expect(getSecret(SERVICE, ACCOUNT, { treatUnreadableAsAbsent: false })).rejects.toThrow(
        /could not be read this run/
      )
    })
  })

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
})
