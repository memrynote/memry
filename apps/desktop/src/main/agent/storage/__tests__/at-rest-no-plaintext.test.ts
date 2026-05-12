import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sodium from 'libsodium-wrappers-sumo'

import * as schema from '@memry/db-schema/data-schema'
import { createConversationStore } from '../conversation-store'
import { createMessageStore } from '../message-store'

const SECRET = 'this-string-must-not-leak-to-disk-PLAINTEXT-MARKER'

describe('At-rest encryption forensics', () => {
  let vaultKey: Uint8Array
  let tmpFiles: string[] = []

  beforeAll(async () => {
    await sodium.ready
    vaultKey = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES)
  })

  afterEach(() => {
    for (const file of tmpFiles) {
      try {
        fs.unlinkSync(file)
      } catch {
        // best-effort cleanup
      }
    }
    tmpFiles = []
  })

  it('never writes plaintext message body or conversation title to a real DB file', () => {
    const tmp = path.join(os.tmpdir(), `memry-agent-${Date.now()}.sqlite`)
    tmpFiles.push(tmp)

    const sqlite = new Database(tmp)
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
    const db = drizzle(sqlite, { schema })
    const conversationStore = createConversationStore({ db, vaultKey, deviceId: 'd1' })
    const messageStore = createMessageStore({ db, vaultKey, deviceId: 'd1' })

    const conversation = conversationStore.create({
      vaultId: 'v',
      title: SECRET,
      backend: 'claude_cli'
    })
    messageStore.append({
      conversationId: conversation.id,
      role: 'user',
      content: { role: 'user', data: { text: SECRET } },
      attachments: [],
      status: 'completed'
    })
    sqlite.close()

    expect(fs.readFileSync(tmp).toString('utf8')).not.toContain(SECRET)
  })
})
