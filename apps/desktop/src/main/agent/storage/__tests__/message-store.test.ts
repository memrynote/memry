import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import sodium from 'libsodium-wrappers-sumo'

import * as schema from '@memry/db-schema/data-schema'
import { createMessageStore } from '../message-store'

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
  `)
  return drizzle(sqlite, { schema })
}

describe('Message store', () => {
  let vaultKey: Uint8Array
  let db: ReturnType<typeof freshDb>
  let store: ReturnType<typeof createMessageStore>

  beforeAll(async () => {
    await sodium.ready
    vaultKey = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES)
  })

  beforeEach(() => {
    db = freshDb()
    store = createMessageStore({ db, vaultKey, deviceId: 'device-1' })
  })

  it('appends a user message', () => {
    const message = store.append({
      conversationId: 'conv-1',
      role: 'user',
      content: { role: 'user', data: { text: 'hi' } },
      attachments: [],
      status: 'completed'
    })

    expect(message.id).toBeDefined()
    expect(message.status).toBe('completed')

    const back = store.getById(message.id)
    expect(back?.content).toEqual({ role: 'user', data: { text: 'hi' } })
  })

  it('encrypts the body on disk', () => {
    store.append({
      conversationId: 'c',
      role: 'user',
      content: { role: 'user', data: { text: 'PLAINTEXT' } },
      attachments: [],
      status: 'completed'
    })

    const raw = db.select().from(schema.agentMessages).all()[0]
    expect(raw.contentCiphertext).not.toContain('PLAINTEXT')
    expect(raw.attachmentsCiphertext).not.toContain('PLAINTEXT')
  })

  it('lists messages oldest to newest by createdAt', async () => {
    const first = store.append({
      conversationId: 'c',
      role: 'user',
      content: { role: 'user', data: { text: 'first' } },
      attachments: [],
      status: 'completed'
    })
    await new Promise((resolve) => setTimeout(resolve, 5))
    const second = store.append({
      conversationId: 'c',
      role: 'assistant',
      content: { role: 'assistant', data: { text: 'second' } },
      attachments: [],
      status: 'completed'
    })

    const list = store.listByConversation('c')
    expect(list.map((message) => message.id)).toEqual([first.id, second.id])
  })

  it('streaming to completed updates allowed, double terminal throws', () => {
    const message = store.append({
      conversationId: 'c',
      role: 'assistant',
      content: { role: 'assistant', data: { text: 'partial' } },
      attachments: [],
      status: 'streaming'
    })

    store.updateStreaming(message.id, {
      content: { role: 'assistant', data: { text: 'partial+' } }
    })
    store.markTerminal(message.id, 'completed', {
      content: { role: 'assistant', data: { text: 'final' } }
    })

    expect(() =>
      store.markTerminal(message.id, 'completed', {
        content: { role: 'assistant', data: { text: 'again' } }
      })
    ).toThrow(/already terminal/i)
  })

  it('updateStreaming on a terminal message throws', () => {
    const message = store.append({
      conversationId: 'c',
      role: 'assistant',
      content: { role: 'assistant', data: { text: 'final' } },
      attachments: [],
      status: 'completed'
    })

    expect(() =>
      store.updateStreaming(message.id, {
        content: { role: 'assistant', data: { text: 'tampered' } }
      })
    ).toThrow(/terminal/i)
  })
})
