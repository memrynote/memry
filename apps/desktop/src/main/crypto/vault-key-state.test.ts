import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import sodium from 'libsodium-wrappers-sumo'
import keytar from 'keytar'

import * as schema from '@memry/db-schema/data-schema'
import { KEYCHAIN_ENTRIES, KEY_DERIVATION_CONTEXTS } from '@memry/contracts/crypto'

import { deriveKey } from './keys'
import {
  VAULT_KEY_VERIFIER_SETTING,
  computeVaultKeyVerifier,
  getOrInitializeLocalVaultKey
} from './vault-key-state'

vi.mock('keytar', () => ({
  default: {
    setPassword: vi.fn(),
    getPassword: vi.fn(),
    deletePassword: vi.fn()
  }
}))

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

function keychainPassword(bytes: Uint8Array): string {
  return sodium.to_base64(bytes, sodium.base64_variants.ORIGINAL)
}

describe('vault key state', () => {
  beforeAll(async () => {
    await sodium.ready
  })

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('creates and binds a local master key when the vault has no encrypted agent data', async () => {
    const db = freshDb()
    let storedMasterKey = ''
    vi.mocked(keytar.getPassword).mockResolvedValue(null)
    vi.mocked(keytar.setPassword).mockImplementation(async (_service, _account, password) => {
      storedMasterKey = password
    })

    const vaultKey = await getOrInitializeLocalVaultKey(db, 'vault-1')

    expect(vaultKey).toHaveLength(32)
    expect(keytar.setPassword).toHaveBeenCalledWith(
      KEYCHAIN_ENTRIES.MASTER_KEY.service,
      KEYCHAIN_ENTRIES.MASTER_KEY.account,
      expect.any(String)
    )
    expect(storedMasterKey).not.toBe('')

    const verifier = db
      .select({ value: schema.settings.value })
      .from(schema.settings)
      .where(eq(schema.settings.key, VAULT_KEY_VERIFIER_SETTING))
      .get()
    expect(verifier?.value).toBe(computeVaultKeyVerifier(vaultKey, 'vault-1'))
  })

  it('resets legacy unbound agent data before creating a local master key', async () => {
    const db = freshDb()
    db.insert(schema.agentConversations)
      .values({
        id: 'conversation-1',
        vaultId: 'vault-1',
        titleCiphertext: '{"version":1,"nonce":"x","ciphertext":"y"}',
        backend: 'claude_cli',
        backendModel: null,
        trustList: [],
        pinned: false,
        vectorClock: {},
        fieldClocks: {},
        createdAt: 1,
        updatedAt: 1,
        deletedAt: null,
        lastSyncedAt: null
      })
      .run()
    vi.mocked(keytar.getPassword).mockResolvedValue(null)

    await getOrInitializeLocalVaultKey(db, 'vault-1')

    const conversations = db.select().from(schema.agentConversations).all()
    expect(conversations).toEqual([])
    expect(keytar.setPassword).toHaveBeenCalledWith(
      KEYCHAIN_ENTRIES.MASTER_KEY.service,
      KEYCHAIN_ENTRIES.MASTER_KEY.account,
      expect.any(String)
    )
  })

  it('does not create a replacement master key when the vault already has a verifier', async () => {
    const db = freshDb()
    db.insert(schema.settings)
      .values({ key: VAULT_KEY_VERIFIER_SETTING, value: 'existing-verifier' })
      .run()
    vi.mocked(keytar.getPassword).mockResolvedValue(null)

    await expect(getOrInitializeLocalVaultKey(db, 'vault-1')).rejects.toThrow(
      'Vault key verifier exists but master key is missing'
    )
    expect(keytar.setPassword).not.toHaveBeenCalled()
  })

  it('rejects a keychain master key that does not match the vault verifier', async () => {
    const db = freshDb()
    const masterA = new Uint8Array(32).fill(0x11)
    const masterB = new Uint8Array(32).fill(0x22)
    const vaultKeyA = await deriveKey(masterA, KEY_DERIVATION_CONTEXTS.VAULT_KEY, 32)

    db.insert(schema.settings)
      .values({
        key: VAULT_KEY_VERIFIER_SETTING,
        value: computeVaultKeyVerifier(vaultKeyA, 'vault-1')
      })
      .run()

    vi.mocked(keytar.getPassword).mockImplementation(async (_service, account) => {
      if (account === KEYCHAIN_ENTRIES.MASTER_KEY.account) return keychainPassword(masterB)
      return null
    })

    await expect(getOrInitializeLocalVaultKey(db, 'vault-1')).rejects.toThrow(
      'Current master key does not match this vault'
    )
  })
})
