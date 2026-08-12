import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import sodium from 'libsodium-wrappers-sumo'

import * as schema from '@memry/db-schema/data-schema'
import { createConversationStore } from '../conversation-store'

function freshDb() {
  const sqlite = new Database(':memory:')
  sqlite.exec(`
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
  `)
  return drizzle(sqlite, { schema })
}

describe('Conversation store', () => {
  let vaultKey: Uint8Array
  let db: ReturnType<typeof freshDb>
  let store: ReturnType<typeof createConversationStore>

  beforeAll(async () => {
    await sodium.ready
    vaultKey = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES)
  })

  beforeEach(() => {
    db = freshDb()
    store = createConversationStore({ db, vaultKey, deviceId: 'device-1' })
  })

  it('creates a conversation with encrypted title', () => {
    const conv = store.create({
      vaultId: 'vault-uuid',
      title: 'My new chat',
      backend: 'claude_cli',
      backendModel: null
    })

    expect(conv.id).toBeDefined()
    expect(conv.title).toBe('My new chat')
    expect(conv.backend).toBe('claude_cli')
    expect(conv.backendModel).toBeNull()
    expect(conv.trustList).toEqual([])
    expect(conv.pinned).toBe(false)

    const raw = db
      .select({ titleCiphertext: schema.agentConversations.titleCiphertext })
      .from(schema.agentConversations)
      .all()[0]
    expect(raw.titleCiphertext).not.toContain('My new chat')
  })

  it('reads back a conversation by id and decrypts the title', () => {
    const created = store.create({
      vaultId: 'vault-uuid',
      title: 'Hello',
      backend: 'local_openai_compatible',
      backendModel: 'llama3.2'
    })
    const fetched = store.getById(created.id)
    expect(fetched?.title).toBe('Hello')
    expect(fetched?.backend).toBe('local_openai_compatible')
    expect(fetched?.backendModel).toBe('llama3.2')
  })

  it('lists conversations by vault, newest first', async () => {
    store.create({ vaultId: 'v', title: 'Old', backend: 'claude_cli' })
    await new Promise((resolve) => setTimeout(resolve, 5))
    store.create({ vaultId: 'v', title: 'New', backend: 'claude_cli' })

    const list = store.listByVault('v')
    expect(list.map((conversation) => conversation.title)).toEqual(['New', 'Old'])
  })

  it('skips undecryptable conversations when listing a vault', () => {
    const otherKey = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES)
    const otherStore = createConversationStore({ db, vaultKey: otherKey, deviceId: 'device-2' })
    otherStore.create({ vaultId: 'v', title: 'Unreadable', backend: 'claude_cli' })
    store.create({ vaultId: 'v', title: 'Readable', backend: 'claude_cli' })

    const list = store.listByVault('v')

    expect(list.map((conversation) => conversation.title)).toEqual(['Readable'])
  })

  it('updates pinned status and bumps the field clock for pinned only', () => {
    const conversation = store.create({ vaultId: 'v', title: 'X', backend: 'claude_cli' })
    const before = conversation.fieldClocks

    const updated = store.update(conversation.id, { pinned: true }, ['pinned'])

    expect(updated.pinned).toBe(true)
    expect(updated.fieldClocks.pinned['device-1']).toBe((before.pinned?.['device-1'] ?? 0) + 1)
    expect(updated.fieldClocks.title['device-1']).toBe(before.title?.['device-1'])
  })

  it('updates title and re-encrypts', () => {
    const conversation = store.create({ vaultId: 'v', title: 'A', backend: 'claude_cli' })
    const updated = store.update(conversation.id, { title: 'B' }, ['title'])

    expect(updated.title).toBe('B')
    const refetched = store.getById(conversation.id)
    expect(refetched?.title).toBe('B')
  })

  it('updates backend model metadata and bumps the field clock', () => {
    const conversation = store.create({
      vaultId: 'v',
      title: 'X',
      backend: 'claude_cli',
      backendModel: null
    })
    const before = conversation.fieldClocks

    const updated = store.update(
      conversation.id,
      { backend: 'local_openai_compatible', backendModel: 'llama3.2' },
      ['backend', 'backendModel']
    )

    expect(updated.backend).toBe('local_openai_compatible')
    expect(updated.backendModel).toBe('llama3.2')
    expect(updated.fieldClocks.backendModel['device-1']).toBe(
      (before.backendModel?.['device-1'] ?? 0) + 1
    )
  })

  it('soft-deletes a conversation', () => {
    const conversation = store.create({ vaultId: 'v', title: 'X', backend: 'claude_cli' })
    store.softDelete(conversation.id)

    const fetched = store.getById(conversation.id, { includeDeleted: true })
    expect(fetched?.deletedAt).not.toBeNull()
  })

  it('hides a soft-deleted conversation from getById by default', () => {
    const conversation = store.create({ vaultId: 'v', title: 'X', backend: 'claude_cli' })
    store.softDelete(conversation.id)

    expect(store.getById(conversation.id)).toBeNull()
    expect(store.listByVault('v')).toEqual([])
  })

  it('refuses to mutate the trust list of a soft-deleted conversation', () => {
    const conversation = store.create({ vaultId: 'v', title: 'X', backend: 'claude_cli' })
    store.softDelete(conversation.id)

    expect(() => store.addToTrustList(conversation.id, 'vault_create_note')).toThrow(
      `Conversation ${conversation.id} not found`
    )
    expect(() => store.removeFromTrustList(conversation.id, 'vault_create_note')).toThrow(
      `Conversation ${conversation.id} not found`
    )
    expect(store.getById(conversation.id, { includeDeleted: true })?.trustList).toEqual([])
  })

  it('still soft-deletes a conversation the sync layer already tombstoned', () => {
    const conversation = store.create({ vaultId: 'v', title: 'X', backend: 'claude_cli' })
    db.update(schema.agentConversations)
      .set({ deletedAt: 1 })
      .where(eq(schema.agentConversations.id, conversation.id))
      .run()

    store.softDelete(conversation.id)

    const fetched = store.getById(conversation.id, { includeDeleted: true })
    expect(fetched?.deletedAt).not.toBe(1)
    expect(fetched?.vectorClock['device-1']).toBe(2)
  })

  it('addToTrustList is idempotent', () => {
    const conversation = store.create({ vaultId: 'v', title: 'X', backend: 'claude_cli' })
    store.addToTrustList(conversation.id, 'vault_create_note')
    store.addToTrustList(conversation.id, 'vault_create_note')

    const fetched = store.getById(conversation.id)
    expect(fetched?.trustList).toEqual(['vault_create_note'])
  })
})
