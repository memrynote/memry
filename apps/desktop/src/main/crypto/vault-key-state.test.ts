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
  bindLocalVaultToMasterKey,
  computeVaultKeyVerifier,
  getOrInitializeLocalVaultKey
} from './vault-key-state'
import { resetAccountKeyCheckerForTests, setAccountKeyChecker } from './vault-key-policy'

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

    CREATE TABLE sync_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
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
    resetAccountKeyCheckerForTests()
  })

  function readVerifier(db: ReturnType<typeof freshDb>): string | undefined {
    return db
      .select({ value: schema.settings.value })
      .from(schema.settings)
      .where(eq(schema.settings.key, VAULT_KEY_VERIFIER_SETTING))
      .get()?.value
  }

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

  // An account owns the key, so the recovery phrase can re-derive it. Minting a
  // replacement would strand everything the account encrypted under the real one.
  it('does not create a replacement master key while sync credentials exist', async () => {
    const db = freshDb()
    db.insert(schema.settings)
      .values({ key: VAULT_KEY_VERIFIER_SETTING, value: 'existing-verifier' })
      .run()
    vi.mocked(keytar.getPassword).mockImplementation(async (_service, account) => {
      if (account === KEYCHAIN_ENTRIES.REFRESH_TOKEN.account) {
        return keychainPassword(new Uint8Array(32).fill(0x33))
      }
      return null
    })

    await expect(getOrInitializeLocalVaultKey(db, 'vault-1')).rejects.toThrow(
      'cannot create a local vault key while sync credentials exist'
    )
    expect(keytar.setPassword).not.toHaveBeenCalled()
  })

  // The missing-key twin of the mismatch case: a vault folder that lands on a
  // machine which never had a key, with no account to restore one from. Nobody
  // can reconstruct what the verifier was bound to, so dead-ending the vault
  // buys nothing.
  it('mints a key and rebinds when the vault has a verifier but no account', async () => {
    const db = freshDb()
    db.insert(schema.settings)
      .values({ key: VAULT_KEY_VERIFIER_SETTING, value: 'from-another-machine' })
      .run()
    vi.mocked(keytar.getPassword).mockResolvedValue(null)

    const vaultKey = await getOrInitializeLocalVaultKey(db, 'vault-1')

    expect(keytar.setPassword).toHaveBeenCalled()
    expect(readVerifier(db)).toBe(computeVaultKeyVerifier(vaultKey, 'vault-1'))
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
      if (account === KEYCHAIN_ENTRIES.REFRESH_TOKEN.account)
        return keychainPassword(new Uint8Array(32).fill(0x33))
      return null
    })
    setAccountKeyChecker(async () => 'mismatch')

    await expect(getOrInitializeLocalVaultKey(db, 'vault-1')).rejects.toThrow(
      'Current master key does not match this vault'
    )
  })

  // A vault folder moved between machines with git / iCloud / Dropbox brings the
  // other machine's verifier with it. On a device with no account there is no
  // recovery phrase to re-derive the key that sealed the agent rows, so failing
  // would disable Agent Chat forever on a vault whose notes open fine.
  it('rebinds a mismatched vault on a device that has no account to recover from', async () => {
    const db = freshDb()
    const otherMachineMaster = new Uint8Array(32).fill(0x11)
    const localMaster = new Uint8Array(32).fill(0x22)
    const otherMachineVaultKey = await deriveKey(
      otherMachineMaster,
      KEY_DERIVATION_CONTEXTS.VAULT_KEY,
      32
    )

    db.insert(schema.settings)
      .values({
        key: VAULT_KEY_VERIFIER_SETTING,
        value: computeVaultKeyVerifier(otherMachineVaultKey, 'vault-1')
      })
      .run()

    // Master key present, but no refresh token and no signing key: local-only.
    vi.mocked(keytar.getPassword).mockImplementation(async (_service, account) => {
      if (account === KEYCHAIN_ENTRIES.MASTER_KEY.account) return keychainPassword(localMaster)
      return null
    })

    const vaultKey = await getOrInitializeLocalVaultKey(db, 'vault-1')

    expect(readVerifier(db)).toBe(computeVaultKeyVerifier(vaultKey, 'vault-1'))
  })

  // The account already confirmed this device holds the right key, so the row
  // that disagrees is the vault's — it travelled in from a machine that was
  // linked before this one, or was left behind by a re-link that only rebound
  // whichever vault happened to be open.
  it('rebinds a stale vault verifier when the account confirms the local key', async () => {
    const db = freshDb()
    const staleMaster = new Uint8Array(32).fill(0x11)
    const accountMaster = new Uint8Array(32).fill(0x22)
    const staleVaultKey = await deriveKey(staleMaster, KEY_DERIVATION_CONTEXTS.VAULT_KEY, 32)

    db.insert(schema.settings)
      .values({
        key: VAULT_KEY_VERIFIER_SETTING,
        value: computeVaultKeyVerifier(staleVaultKey, 'vault-1')
      })
      .run()

    vi.mocked(keytar.getPassword).mockImplementation(async (_service, account) => {
      if (account === KEYCHAIN_ENTRIES.MASTER_KEY.account) return keychainPassword(accountMaster)
      if (account === KEYCHAIN_ENTRIES.REFRESH_TOKEN.account)
        return keychainPassword(new Uint8Array(32).fill(0x33))
      return null
    })
    setAccountKeyChecker(async () => 'match')

    const vaultKey = await getOrInitializeLocalVaultKey(db, 'vault-1')

    expect(readVerifier(db)).toBe(computeVaultKeyVerifier(vaultKey, 'vault-1'))
  })

  it.each(['transition', 'unknown'] as const)(
    'still refuses to rebind while the account key check is %s',
    async (verdict) => {
      const db = freshDb()
      const masterA = new Uint8Array(32).fill(0x11)
      const masterB = new Uint8Array(32).fill(0x22)
      const vaultKeyA = await deriveKey(masterA, KEY_DERIVATION_CONTEXTS.VAULT_KEY, 32)
      const expected = computeVaultKeyVerifier(vaultKeyA, 'vault-1')

      db.insert(schema.settings).values({ key: VAULT_KEY_VERIFIER_SETTING, value: expected }).run()

      vi.mocked(keytar.getPassword).mockImplementation(async (_service, account) => {
        if (account === KEYCHAIN_ENTRIES.MASTER_KEY.account) return keychainPassword(masterB)
        if (account === KEYCHAIN_ENTRIES.REFRESH_TOKEN.account)
          return keychainPassword(new Uint8Array(32).fill(0x33))
        return null
      })
      setAccountKeyChecker(async () => verdict)

      await expect(getOrInitializeLocalVaultKey(db, 'vault-1')).rejects.toThrow(
        'Current master key does not match this vault'
      )
      expect(readVerifier(db)).toBe(expected)
    }
  )

  it('rebinds the verifier to a new account master key and clears old encrypted agent data', async () => {
    const db = freshDb()
    const localMaster = new Uint8Array(32).fill(0x11)
    const accountMaster = new Uint8Array(32).fill(0x22)
    const localVaultKey = await deriveKey(localMaster, KEY_DERIVATION_CONTEXTS.VAULT_KEY, 32)
    const accountVaultKey = await deriveKey(accountMaster, KEY_DERIVATION_CONTEXTS.VAULT_KEY, 32)

    db.insert(schema.settings)
      .values({
        key: VAULT_KEY_VERIFIER_SETTING,
        value: computeVaultKeyVerifier(localVaultKey, 'vault-1')
      })
      .run()
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
    db.insert(schema.agentMessages)
      .values({
        id: 'message-1',
        conversationId: 'conversation-1',
        role: 'assistant',
        contentCiphertext: '{"version":1,"nonce":"x","ciphertext":"y"}',
        attachmentsCiphertext: '{"version":1,"nonce":"x","ciphertext":"y"}',
        toolCallId: null,
        status: 'complete',
        vectorClock: {},
        createdAt: 1,
        updatedAt: 1,
        deletedAt: null
      })
      .run()

    await bindLocalVaultToMasterKey(db, 'vault-1', accountMaster)

    const verifier = db
      .select({ value: schema.settings.value })
      .from(schema.settings)
      .where(eq(schema.settings.key, VAULT_KEY_VERIFIER_SETTING))
      .get()
    expect(verifier?.value).toBe(computeVaultKeyVerifier(accountVaultKey, 'vault-1'))
    expect(db.select().from(schema.agentConversations).all()).toEqual([])
    expect(db.select().from(schema.agentMessages).all()).toEqual([])
  })

  it('purges the pull cursor and quarantine state when the verifier is REWRITTEN to a new key', async () => {
    const db = freshDb()
    const localMaster = new Uint8Array(32).fill(0x11)
    const accountMaster = new Uint8Array(32).fill(0x22)
    const localVaultKey = await deriveKey(localMaster, KEY_DERIVATION_CONTEXTS.VAULT_KEY, 32)

    db.insert(schema.settings)
      .values({
        key: VAULT_KEY_VERIFIER_SETTING,
        value: computeVaultKeyVerifier(localVaultKey, 'vault-1')
      })
      .run()
    // State branded while the WRONG key was active: a cursor that advanced
    // past items that failed to apply, and items quarantined by signature
    // failures. Both are meaningless — and harmful — under the corrected key.
    db.insert(schema.syncState)
      .values([
        { key: 'lastCursor', value: '12345', updatedAt: new Date() },
        { key: 'quarantinedItems', value: '[{"itemId":"n-1"}]', updatedAt: new Date() },
        { key: 'initialSeedDone', value: 'true', updatedAt: new Date() }
      ])
      .run()

    await bindLocalVaultToMasterKey(db, 'vault-1', accountMaster)

    const remaining = db.select().from(schema.syncState).all()
    const keys = remaining.map((r) => r.key)
    expect(keys).not.toContain('lastCursor')
    expect(keys).not.toContain('quarantinedItems')
    // Unrelated sync state survives.
    expect(keys).toContain('initialSeedDone')
  })

  it('does NOT purge sync state on a fresh bind (no previous verifier)', async () => {
    const db = freshDb()
    const accountMaster = new Uint8Array(32).fill(0x22)
    db.insert(schema.syncState)
      .values([{ key: 'lastCursor', value: '777', updatedAt: new Date() }])
      .run()

    await bindLocalVaultToMasterKey(db, 'vault-1', accountMaster)

    const keys = db
      .select()
      .from(schema.syncState)
      .all()
      .map((r) => r.key)
    expect(keys).toContain('lastCursor')
  })
})
