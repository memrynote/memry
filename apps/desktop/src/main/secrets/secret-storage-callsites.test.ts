import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import Database from 'better-sqlite3'
import sodium from 'libsodium-wrappers-sumo'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import * as schema from '@memry/db-schema/data-schema'
import { KEYCHAIN_ENTRIES } from '@memry/contracts/crypto'
import { drizzle } from 'drizzle-orm/better-sqlite3'

const harness = vi.hoisted(() => {
  const keytarStore = new Map<string, string>()
  return {
    appReady: true,
    encryptionAvailable: true,
    userDataDir: '',
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
    getPath: () => harness.userDataDir
  },
  safeStorage: {
    isEncryptionAvailable: () => harness.encryptionAvailable,
    getSelectedStorageBackend: () => 'keychain_access',
    encryptString: (value: string) => Buffer.from(`enc:${value}`, 'utf-8'),
    decryptString: (buf: Buffer) => {
      const raw = buf.toString('utf-8')
      if (!raw.startsWith('enc:')) throw new Error('safeStorage decrypt failed')
      return raw.slice(4)
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

vi.mock('../store', () => ({
  store: {
    get: () => undefined,
    set: () => undefined
  }
}))

import { resetSecretStorageForTests, SECRET_STORE_FILENAME } from './secret-storage'
import { confirmMasterKeyMigrated, deleteKey, retrieveKey, storeKey } from '../crypto/keychain'
import { getGoogleCalendarTokens, storeGoogleCalendarTokens } from '../calendar/google/keychain'
import {
  getVoiceTranscriptionOpenAIApiKey,
  setVoiceTranscriptionOpenAIApiKey
} from '../inbox/voice-transcription-keychain'
import {
  getLocalProviderApiKey,
  setLocalProviderApiKey
} from '../agent/backends/local-provider-keychain'
import { getOrInitializeLocalVaultKey } from '../crypto/vault-key-state'

const MASTER = KEYCHAIN_ENTRIES.MASTER_KEY
const SIGNING = KEYCHAIN_ENTRIES.DEVICE_SIGNING_KEY

const toB64 = (bytes: Uint8Array): string =>
  sodium.to_base64(bytes, sodium.base64_variants.ORIGINAL)

const cipherFor = (value: string): string => Buffer.from(`enc:${value}`, 'utf-8').toString('base64')

const readStoreJson = (): { entries: Record<string, Record<string, string>> } =>
  JSON.parse(fs.readFileSync(path.join(harness.userDataDir, SECRET_STORE_FILENAME), 'utf-8'))

const storeFileExists = (): boolean =>
  fs.existsSync(path.join(harness.userDataDir, SECRET_STORE_FILENAME))

function freshDb() {
  const sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      modified_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE TABLE agent_conversations (
      id TEXT PRIMARY KEY,
      vault_id TEXT NOT NULL,
      title_ciphertext TEXT NOT NULL,
      backend TEXT NOT NULL,
      backend_model TEXT,
      trust_list TEXT NOT NULL DEFAULT '[]',
      pinned INTEGER NOT NULL DEFAULT 0,
      vector_clock TEXT NOT NULL,
      field_clocks TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER,
      last_synced_at INTEGER
    );

    CREATE TABLE agent_messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content_ciphertext TEXT NOT NULL,
      attachments_ciphertext TEXT NOT NULL,
      tool_call_id TEXT,
      status TEXT NOT NULL,
      vector_clock TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER
    );
  `)
  return drizzle(sqlite, { schema })
}

describe('secret-storage call sites — account string preservation and migration', () => {
  beforeAll(async () => {
    await sodium.ready
  })

  beforeEach(() => {
    vi.clearAllMocks()
    resetSecretStorageForTests()
    harness.appReady = true
    harness.encryptionAvailable = true
    harness.keytarStore.clear()
    harness.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-secret-callsites-'))
    delete process.env.MEMRY_DEVICE
  })

  afterEach(() => {
    delete process.env.MEMRY_DEVICE
    fs.rmSync(harness.userDataDir, { recursive: true, force: true })
  })

  // --------------------------------------------------------------------------
  // crypto/keychain — vault master key and sync keys
  // --------------------------------------------------------------------------

  describe('crypto/keychain', () => {
    it('stores keys under the exact device-suffixed account (MEMRY_DEVICE=A)', async () => {
      process.env.MEMRY_DEVICE = 'A'
      const key = new Uint8Array([1, 2, 3, 4])

      await storeKey(MASTER, key)

      expect(readStoreJson().entries['com.memry.sync']['master-key-A']).toBe(cipherFor(toB64(key)))
      expect(harness.keytarSet).not.toHaveBeenCalled()
      await expect(retrieveKey(MASTER)).resolves.toEqual(key)
    })

    it('migrates a non-master key from keytar immediately after verification', async () => {
      const key = new Uint8Array([9, 8, 7])
      harness.keytarStore.set(`${SIGNING.service}:${SIGNING.account}`, toB64(key))

      await expect(retrieveKey(SIGNING)).resolves.toEqual(key)

      expect(readStoreJson().entries[SIGNING.service][SIGNING.account]).toBe(cipherFor(toB64(key)))
      expect(harness.keytarDelete).toHaveBeenCalledWith(SIGNING.service, SIGNING.account)
    })

    it('defers the master key keytar delete until confirmMasterKeyMigrated', async () => {
      const key = new Uint8Array([5, 5, 5, 5])
      harness.keytarStore.set(`${MASTER.service}:${MASTER.account}`, toB64(key))

      await expect(retrieveKey(MASTER)).resolves.toEqual(key)

      expect(readStoreJson().entries[MASTER.service][MASTER.account]).toBe(cipherFor(toB64(key)))
      expect(harness.keytarDelete).not.toHaveBeenCalled()
      expect(harness.keytarStore.get(`${MASTER.service}:${MASTER.account}`)).toBe(toB64(key))

      await confirmMasterKeyMigrated()

      expect(harness.keytarDelete).toHaveBeenCalledWith(MASTER.service, MASTER.account)
      expect(harness.keytarStore.has(`${MASTER.service}:${MASTER.account}`)).toBe(false)
    })

    it('keeps keytar authoritative for plain-dev worktrees (shared dev keychain)', async () => {
      process.env.MEMRY_DEVICE = 'dev-0123abcd'
      const key = new Uint8Array([7, 7, 7])

      await storeKey(MASTER, key)

      expect(harness.keytarSet).toHaveBeenCalledWith('com.memry.sync', 'master-key-dev', toB64(key))
      expect(storeFileExists()).toBe(false)

      await expect(retrieveKey(MASTER)).resolves.toEqual(key)
      await confirmMasterKeyMigrated()
      expect(harness.keytarDelete).not.toHaveBeenCalled()

      await deleteKey(MASTER)
      expect(harness.keytarDelete).toHaveBeenCalledWith('com.memry.sync', 'master-key-dev')
    })

    it('completes the master key migration only after the vault verifier accepts the key', async () => {
      const db = freshDb()
      const masterKey = sodium.randombytes_buf(32)
      harness.keytarStore.set(`${MASTER.service}:${MASTER.account}`, toB64(masterKey))

      const vaultKey = await getOrInitializeLocalVaultKey(db, 'vault-1')

      expect(vaultKey).toHaveLength(32)
      // Migration persisted the key and, because the verifier check passed,
      // the OS keychain copy is gone.
      expect(readStoreJson().entries[MASTER.service][MASTER.account]).toBe(
        cipherFor(toB64(masterKey))
      )
      expect(harness.keytarStore.has(`${MASTER.service}:${MASTER.account}`)).toBe(false)
    })

    it('stops paying the OS keychain round-trip on repeat vault-key fetches', async () => {
      const db = freshDb()
      const masterKey = sodium.randombytes_buf(32)
      harness.keytarStore.set(`${MASTER.service}:${MASTER.account}`, toB64(masterKey))

      const first = await getOrInitializeLocalVaultKey(db, 'vault-1')

      harness.keytarGet.mockClear()
      for (let i = 0; i < 10; i += 1) {
        // Same key every time — the latch only skips work that is provably a
        // no-op, it never changes what the fetch returns.
        await expect(getOrInitializeLocalVaultKey(db, 'vault-1')).resolves.toEqual(first)
      }

      expect(harness.keytarGet).not.toHaveBeenCalled()
    })

    it('keeps the keytar master key when the vault verifier does not accept it', async () => {
      const db = freshDb()
      const boundKey = sodium.randombytes_buf(32)
      const otherKey = sodium.randombytes_buf(32)

      // Bind the vault to one key, then present a different one from keytar.
      harness.keytarStore.set(`${MASTER.service}:${MASTER.account}`, toB64(boundKey))
      await getOrInitializeLocalVaultKey(db, 'vault-1')

      resetSecretStorageForTests()
      harness.keytarStore.set(`${MASTER.service}:${MASTER.account}`, toB64(otherKey))
      fs.rmSync(path.join(harness.userDataDir, SECRET_STORE_FILENAME), { force: true })
      harness.keytarDelete.mockClear()

      // No account on this device, so the vault rebinds to the presented key
      // rather than disabling itself (crypto/vault-key-policy.ts).
      await getOrInitializeLocalVaultKey(db, 'vault-1')

      // Verification never passed — a rebind does not count — so the OS keychain
      // copy must survive.
      expect(harness.keytarDelete).not.toHaveBeenCalled()
      expect(harness.keytarStore.get(`${MASTER.service}:${MASTER.account}`)).toBe(toB64(otherKey))
    })
  })

  // --------------------------------------------------------------------------
  // Google Calendar tokens
  // --------------------------------------------------------------------------

  describe('calendar/google/keychain', () => {
    it('preserves the per-account per-kind per-device account strings', async () => {
      process.env.MEMRY_DEVICE = 'A'

      await storeGoogleCalendarTokens({
        accountId: 'alice@example.com',
        accessToken: 'alice-access',
        refreshToken: 'alice-refresh'
      })

      const entries = readStoreJson().entries['com.memry.calendar.google']
      expect(entries['access-token-alice@example.com-A']).toBe(cipherFor('alice-access'))
      expect(entries['refresh-token-alice@example.com-A']).toBe(cipherFor('alice-refresh'))
      expect(harness.keytarSet).not.toHaveBeenCalled()
    })

    it('migrates legacy keytar tokens read under the identical account strings', async () => {
      harness.keytarStore.set(
        'com.memry.calendar.google:access-token-bob@example.com',
        'bob-access'
      )
      harness.keytarStore.set(
        'com.memry.calendar.google:refresh-token-bob@example.com',
        'bob-refresh'
      )

      await expect(getGoogleCalendarTokens('bob@example.com')).resolves.toEqual({
        accessToken: 'bob-access',
        refreshToken: 'bob-refresh'
      })

      const entries = readStoreJson().entries['com.memry.calendar.google']
      expect(entries['access-token-bob@example.com']).toBe(cipherFor('bob-access'))
      expect(entries['refresh-token-bob@example.com']).toBe(cipherFor('bob-refresh'))
      expect(harness.keytarDelete).toHaveBeenCalledWith(
        'com.memry.calendar.google',
        'access-token-bob@example.com'
      )
      expect(harness.keytarDelete).toHaveBeenCalledWith(
        'com.memry.calendar.google',
        'refresh-token-bob@example.com'
      )
    })
  })

  // --------------------------------------------------------------------------
  // Voice transcription API key
  // --------------------------------------------------------------------------

  describe('inbox/voice-transcription-keychain', () => {
    it('preserves the device-suffixed account string', async () => {
      process.env.MEMRY_DEVICE = 'A'

      await setVoiceTranscriptionOpenAIApiKey('sk-voice')

      expect(readStoreJson().entries['memry.voice-transcription']['openai-A']).toBe(
        cipherFor('sk-voice')
      )
    })

    it('migrates the legacy keytar key on read', async () => {
      harness.keytarStore.set('memry.voice-transcription:openai', 'sk-legacy')

      await expect(getVoiceTranscriptionOpenAIApiKey()).resolves.toBe('sk-legacy')

      expect(readStoreJson().entries['memry.voice-transcription']['openai']).toBe(
        cipherFor('sk-legacy')
      )
      expect(harness.keytarDelete).toHaveBeenCalledWith('memry.voice-transcription', 'openai')
    })
  })

  // --------------------------------------------------------------------------
  // Agent local provider API key
  // --------------------------------------------------------------------------

  describe('agent/backends/local-provider-keychain', () => {
    it('preserves the colon-separated device account string', async () => {
      process.env.MEMRY_DEVICE = ' A '

      await setLocalProviderApiKey('sk-local')

      expect(readStoreJson().entries['memry.agent.local-provider']['api-key:A']).toBe(
        cipherFor('sk-local')
      )
    })

    it('migrates the legacy keytar key on read', async () => {
      harness.keytarStore.set('memry.agent.local-provider:api-key', 'sk-legacy')

      await expect(getLocalProviderApiKey()).resolves.toBe('sk-legacy')

      expect(readStoreJson().entries['memry.agent.local-provider']['api-key']).toBe(
        cipherFor('sk-legacy')
      )
      expect(harness.keytarDelete).toHaveBeenCalledWith('memry.agent.local-provider', 'api-key')
    })
  })

  // --------------------------------------------------------------------------
  // Capture pairing token
  // --------------------------------------------------------------------------

  describe('capture/pairing', () => {
    it('keeps the unsuffixed pairing-token account even when MEMRY_DEVICE is set', async () => {
      process.env.MEMRY_DEVICE = 'A'
      vi.resetModules()
      const { getCaptureToken } = await import('../capture/pairing')

      const token = await getCaptureToken()

      expect(token).toHaveLength(64)
      expect(readStoreJson().entries['com.memry.capture']['pairing-token']).toBe(cipherFor(token))
      expect(harness.keytarSet).not.toHaveBeenCalled()
    })

    it('migrates a legacy keytar pairing token on read', async () => {
      vi.resetModules()
      const legacyToken = 'a'.repeat(64)
      harness.keytarStore.set('com.memry.capture:pairing-token', legacyToken)
      const { getCaptureToken } = await import('../capture/pairing')

      await expect(getCaptureToken()).resolves.toBe(legacyToken)

      expect(readStoreJson().entries['com.memry.capture']['pairing-token']).toBe(
        cipherFor(legacyToken)
      )
      expect(harness.keytarDelete).toHaveBeenCalledWith('com.memry.capture', 'pairing-token')
    })
  })
})
