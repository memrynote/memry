import { beforeAll, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import sodium from 'libsodium-wrappers-sumo'

import * as schema from '@memry/db-schema/data-schema'
import { createConversationStore } from '../../../agent/storage/conversation-store'
import { AgentConversationHandler } from '../agent-conversation-handler'

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

const emit = (): void => {}

describe('AgentConversationHandler', () => {
  let vaultKey: Uint8Array

  beforeAll(async () => {
    await sodium.ready
    vaultKey = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES)
  })

  it('applies upsert when no local row exists', () => {
    const db = freshDb()
    const handler = new AgentConversationHandler({ vaultKey })

    const result = handler.applyUpsert(
      { db, emit },
      'c1',
      {
        vaultId: 'v',
        title: 'Hello from remote',
        backend: 'claude_cli',
        backendModel: null,
        trustList: [],
        pinned: false,
        fieldClocks: {
          title: { 'device-1': 1 },
          backend: { 'device-1': 1 },
          backendModel: { 'device-1': 1 },
          trustList: { 'device-1': 1 },
          pinned: { 'device-1': 1 }
        },
        createdAt: 1000,
        updatedAt: 1000
      },
      { 'device-1': 1 }
    )

    expect(result).toBe('applied')
    const store = createConversationStore({ db, vaultKey, deviceId: 'device-2' })
    expect(store.getById('c1')?.title).toBe('Hello from remote')
  })

  it('merges concurrent title and pinned edits', () => {
    const db = freshDb()
    const handler = new AgentConversationHandler({ vaultKey })
    const store = createConversationStore({ db, vaultKey, deviceId: 'device-2' })
    const local = store.create({ vaultId: 'v', title: 'OldTitle', backend: 'claude_cli' })
    store.update(local.id, { pinned: true }, ['pinned'])

    const result = handler.applyUpsert(
      { db, emit },
      local.id,
      {
        vaultId: 'v',
        title: 'NewTitleFromDevice1',
        backend: 'claude_cli',
        backendModel: null,
        trustList: [],
        pinned: false,
        fieldClocks: {
          title: { 'device-1': 5 },
          backend: { 'device-1': 1 },
          backendModel: { 'device-1': 1 },
          trustList: { 'device-1': 1 },
          pinned: { 'device-1': 1 }
        },
        createdAt: local.createdAt,
        updatedAt: Date.now()
      },
      { 'device-1': 5 }
    )

    expect(result).toBe('applied')
    const merged = store.getById(local.id)
    expect(merged?.title).toBe('NewTitleFromDevice1')
    expect(merged?.pinned).toBe(true)
  })

  it('skips stale upserts', () => {
    const db = freshDb()
    const handler = new AgentConversationHandler({ vaultKey })
    const store = createConversationStore({ db, vaultKey, deviceId: 'device-2' })
    const local = store.create({ vaultId: 'v', title: 'Local', backend: 'claude_cli' })
    store.update(local.id, { title: 'Local-v2' }, ['title'])
    store.update(local.id, { title: 'Local-v3' }, ['title'])

    const result = handler.applyUpsert(
      { db, emit },
      local.id,
      {
        vaultId: 'v',
        title: 'Stale',
        backend: 'claude_cli',
        backendModel: null,
        trustList: [],
        pinned: false,
        fieldClocks: {
          title: { 'device-1': 1 },
          backend: { 'device-1': 1 },
          backendModel: { 'device-1': 1 },
          trustList: { 'device-1': 1 },
          pinned: { 'device-1': 1 }
        },
        createdAt: local.createdAt,
        updatedAt: 0
      },
      { 'device-1': 1 }
    )

    expect(result).toBe('skipped')
  })

  it('builds push payload by decrypting the local title', () => {
    const db = freshDb()
    const handler = new AgentConversationHandler({ vaultKey })
    const store = createConversationStore({ db, vaultKey, deviceId: 'device-1' })
    const conversation = store.create({ vaultId: 'v', title: 'Local title', backend: 'claude_cli' })

    const payload = handler.buildPushPayload(db, conversation.id, 'device-1', 'create', vaultKey)
    expect(JSON.parse(payload ?? '{}')).toMatchObject({ title: 'Local title', vaultId: 'v' })
  })
})
