import { beforeAll, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import sodium from 'libsodium-wrappers-sumo'

import * as schema from '@memry/db-schema/data-schema'
import { AgentMessageHandler } from '../agent-message-handler'

function freshDb() {
  const sqlite = new Database(':memory:')
  sqlite.exec(`
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
    -- applyUpsert requires the parent conversation to exist before it will
    -- insert a message (MissingSyncParentError), so a message-only schema no
    -- longer reflects reality. Seeded with the 'c1' parent every case here uses.
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
    INSERT INTO agent_conversations
      (id, vault_id, title_ciphertext, backend, vector_clock, field_clocks, created_at, updated_at)
    VALUES ('c1', 'v1', 'x', 'claude', '{}', '{}', 1, 1);
  `)
  return drizzle(sqlite, { schema })
}

const emit = (): void => {}

describe('AgentMessageHandler', () => {
  let vaultKey: Uint8Array

  beforeAll(async () => {
    await sodium.ready
    vaultKey = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES)
  })

  it('inserts an unseen terminal message', () => {
    const db = freshDb()
    const handler = new AgentMessageHandler({ vaultKey })
    const result = handler.applyUpsert(
      { db, emit },
      'm1',
      {
        conversationId: 'c1',
        role: 'user',
        content: { role: 'user', data: { text: 'hi' } },
        attachments: [],
        status: 'completed',
        toolCallId: null,
        createdAt: 1000,
        updatedAt: 1000
      },
      { d1: 1 }
    )

    expect(result).toBe('applied')
    expect(db.select().from(schema.agentMessages).all()).toHaveLength(1)
  })

  it('is idempotent on duplicate id with same payload', () => {
    const db = freshDb()
    const handler = new AgentMessageHandler({ vaultKey })
    const payload = {
      conversationId: 'c1',
      role: 'user' as const,
      content: { role: 'user' as const, data: { text: 'hi' } },
      attachments: [],
      status: 'completed' as const,
      toolCallId: null,
      createdAt: 1000,
      updatedAt: 1000
    }

    handler.applyUpsert({ db, emit }, 'm1', payload, { d1: 1 })
    const result = handler.applyUpsert({ db, emit }, 'm1', payload, { d1: 1 })
    expect(result).toBe('skipped')
  })

  it('returns conflict when same id has different content', () => {
    const db = freshDb()
    const handler = new AgentMessageHandler({ vaultKey })
    handler.applyUpsert(
      { db, emit },
      'm1',
      {
        conversationId: 'c1',
        role: 'user',
        content: { role: 'user', data: { text: 'first' } },
        attachments: [],
        status: 'completed',
        toolCallId: null,
        createdAt: 1000,
        updatedAt: 1000
      },
      { d1: 1 }
    )

    const result = handler.applyUpsert(
      { db, emit },
      'm1',
      {
        conversationId: 'c1',
        role: 'user',
        content: { role: 'user', data: { text: 'DIFFERENT' } },
        attachments: [],
        status: 'completed',
        toolCallId: null,
        createdAt: 1000,
        updatedAt: 2000
      },
      { d1: 2 }
    )

    expect(result).toBe('conflict')
  })

  it('rejects non-terminal message payloads', () => {
    const db = freshDb()
    const handler = new AgentMessageHandler({ vaultKey })
    const result = handler.applyUpsert(
      { db, emit },
      'm1',
      {
        conversationId: 'c1',
        role: 'assistant',
        content: { role: 'assistant', data: { text: 'partial' } },
        attachments: [],
        status: 'streaming',
        toolCallId: null,
        createdAt: 1000,
        updatedAt: 1000
      },
      { d1: 1 }
    )

    expect(result).toBe('parse_error')
  })
})
