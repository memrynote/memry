import { beforeAll, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import sodium from 'libsodium-wrappers-sumo'

import * as schema from '@memry/db-schema/data-schema'
import { createConversationStore } from '../../storage/conversation-store'
import { createMessageStore } from '../../storage/message-store'
import { backfillAgentChatRows } from '../backfill'

function freshDb() {
  const sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE agent_conversations (
      id TEXT PRIMARY KEY,
      vault_id TEXT NOT NULL,
      title_ciphertext TEXT NOT NULL,
      backend TEXT NOT NULL,
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

describe('backfillAgentChatRows', () => {
  let vaultKey: Uint8Array

  beforeAll(async () => {
    await sodium.ready
    vaultKey = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES)
  })

  it('enqueues every conversation and terminal message', () => {
    const db = freshDb()
    const conversationStore = createConversationStore({ db, vaultKey, deviceId: 'd1' })
    const messageStore = createMessageStore({ db, vaultKey, deviceId: 'd1' })
    const first = conversationStore.create({ vaultId: 'v', title: 'A', backend: 'claude_cli' })
    const second = conversationStore.create({ vaultId: 'v', title: 'B', backend: 'claude_cli' })

    const terminalA = messageStore.append({
      conversationId: first.id,
      role: 'user',
      content: { role: 'user', data: { text: 'hi' } },
      attachments: [],
      status: 'completed'
    })
    messageStore.append({
      conversationId: first.id,
      role: 'assistant',
      content: { role: 'assistant', data: { text: 'partial' } },
      attachments: [],
      status: 'streaming'
    })
    const terminalB = messageStore.append({
      conversationId: second.id,
      role: 'user',
      content: { role: 'user', data: { text: 'x' } },
      attachments: [],
      status: 'completed'
    })

    const enqueue = vi.fn()
    const onProgress = vi.fn()
    backfillAgentChatRows({ db, vaultId: 'v', enqueue, onProgress })

    const calls = enqueue.mock.calls.map((call) => call[0])
    expect(
      calls
        .filter((item) => item.type === 'agent_conversation')
        .map((item) => item.id)
        .sort()
    ).toEqual([first.id, second.id].sort())
    expect(
      calls
        .filter((item) => item.type === 'agent_message')
        .map((item) => item.id)
        .sort()
    ).toEqual([terminalA.id, terminalB.id].sort())
    expect(onProgress).toHaveBeenCalled()
  })

  it('reports progress with done and total', () => {
    const db = freshDb()
    const conversationStore = createConversationStore({ db, vaultKey, deviceId: 'd1' })
    conversationStore.create({ vaultId: 'v', title: 'X', backend: 'claude_cli' })
    conversationStore.create({ vaultId: 'v', title: 'Y', backend: 'claude_cli' })

    const onProgress = vi.fn()
    backfillAgentChatRows({ db, vaultId: 'v', enqueue: () => {}, onProgress })

    expect(onProgress.mock.calls.at(-1)?.[0]).toMatchObject({ done: 2, total: 2 })
  })
})
