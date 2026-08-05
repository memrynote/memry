import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import sodium from 'libsodium-wrappers-sumo'
import { eq } from 'drizzle-orm'
import { agentMessages } from '@memry/db-schema/schema/agent-messages'
import { AgentChannels } from '@memry/contracts/ipc-agent'
import type { AgentMessageSyncPayload } from '@memry/contracts/sync-payloads'
import { createTestDataDb, type TestDataDb } from '../../../test/helpers/test-data-db'

vi.mock('../../lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

import { agentMessageHandler } from './agent-message-handler'

const CHANGED = AgentChannels.events.MESSAGES_CHANGED
const CONVERSATION_ID = 'conv-1'

let db: TestDataDb
let vaultKey: Uint8Array
const emit = vi.fn()

const ctx = (): { db: TestDataDb; emit: typeof emit; vaultKey: Uint8Array } => ({
  db,
  emit,
  vaultKey
})

function payload(overrides: Partial<AgentMessageSyncPayload> = {}): AgentMessageSyncPayload {
  return {
    conversationId: CONVERSATION_ID,
    role: 'user',
    content: { role: 'user', data: { text: 'hello from another device' } },
    attachments: [],
    toolCallId: null,
    status: 'completed',
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides
  }
}

beforeAll(async () => {
  await sodium.ready
  vaultKey = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES)
})

beforeEach(() => {
  db = createTestDataDb()
  emit.mockClear()
})

describe('agentMessageHandler', () => {
  it('inserts a message that does not exist locally and notifies the renderer', () => {
    const result = agentMessageHandler.applyUpsert(ctx(), 'msg-1', payload(), { deviceA: 1 })

    expect(result).toBe('applied')
    const row = db.select().from(agentMessages).where(eq(agentMessages.id, 'msg-1')).get()
    expect(row?.conversationId).toBe(CONVERSATION_ID)
    expect(row?.status).toBe('completed')
    expect(row?.vectorClock).toEqual({ deviceA: 1 })
    expect(emit).toHaveBeenCalledWith(CHANGED, {
      conversationId: CONVERSATION_ID,
      messageId: 'msg-1'
    })
  })

  it('falls back to the payload clock when the envelope clock is empty', () => {
    agentMessageHandler.applyUpsert(ctx(), 'msg-1', payload({ clock: { deviceB: 4 } }), {})

    const row = db.select().from(agentMessages).where(eq(agentMessages.id, 'msg-1')).get()
    expect(row?.vectorClock).toEqual({ deviceB: 4 })
  })

  it('skips a redelivery of the identical payload and emits nothing', () => {
    agentMessageHandler.applyUpsert(ctx(), 'msg-1', payload(), { deviceA: 2 })
    emit.mockClear()

    // Messages are immutable, so the handler dedupes on a payload hash rather
    // than a vector-clock comparison: an older clock on the same body is still
    // a no-op redelivery.
    const result = agentMessageHandler.applyUpsert(ctx(), 'msg-1', payload(), { deviceA: 1 })

    expect(result).toBe('skipped')
    expect(emit).not.toHaveBeenCalled()
  })

  it('reports a conflict without rewriting the row or emitting when the body differs', () => {
    agentMessageHandler.applyUpsert(ctx(), 'msg-1', payload(), { deviceA: 1 })
    const before = db.select().from(agentMessages).where(eq(agentMessages.id, 'msg-1')).get()
    emit.mockClear()

    const result = agentMessageHandler.applyUpsert(
      ctx(),
      'msg-1',
      payload({ content: { role: 'user', data: { text: 'different body' } } }),
      { deviceB: 9 }
    )

    expect(result).toBe('conflict')
    const after = db.select().from(agentMessages).where(eq(agentMessages.id, 'msg-1')).get()
    expect(after?.contentCiphertext).toBe(before?.contentCiphertext)
    expect(emit).not.toHaveBeenCalled()
  })

  it('rejects a non-terminal status as a parse error without emitting', () => {
    const result = agentMessageHandler.applyUpsert(
      ctx(),
      'msg-1',
      { ...payload(), status: 'streaming' } as unknown as AgentMessageSyncPayload,
      { deviceA: 1 }
    )

    expect(result).toBe('parse_error')
    expect(
      db.select().from(agentMessages).where(eq(agentMessages.id, 'msg-1')).get()
    ).toBeUndefined()
    expect(emit).not.toHaveBeenCalled()
  })

  it('soft-deletes on delete and notifies the renderer', () => {
    agentMessageHandler.applyUpsert(ctx(), 'msg-1', payload(), { deviceA: 1 })
    emit.mockClear()

    const result = agentMessageHandler.applyDelete(ctx(), 'msg-1', { deviceA: 2 })

    expect(result).toBe('applied')
    const row = db.select().from(agentMessages).where(eq(agentMessages.id, 'msg-1')).get()
    expect(row?.deletedAt).toBeTruthy()
    expect(emit).toHaveBeenCalledWith(CHANGED, {
      conversationId: CONVERSATION_ID,
      messageId: 'msg-1'
    })
  })

  it('skips a delete for an unknown or already-deleted row and emits nothing', () => {
    expect(agentMessageHandler.applyDelete(ctx(), 'missing', { deviceA: 1 })).toBe('skipped')

    agentMessageHandler.applyUpsert(ctx(), 'msg-1', payload(), { deviceA: 1 })
    agentMessageHandler.applyDelete(ctx(), 'msg-1', { deviceA: 2 })
    emit.mockClear()

    expect(agentMessageHandler.applyDelete(ctx(), 'msg-1', { deviceA: 3 })).toBe('skipped')
    expect(emit).not.toHaveBeenCalled()
  })

  it('returns skipped without emitting when no vault key is available', () => {
    const result = agentMessageHandler.applyUpsert({ db, emit }, 'msg-1', payload(), { deviceA: 1 })

    expect(result).toBe('skipped')
    expect(emit).not.toHaveBeenCalled()
    expect(
      db.select().from(agentMessages).where(eq(agentMessages.id, 'msg-1')).get()
    ).toBeUndefined()
  })
})
