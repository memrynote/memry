import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import sodium from 'libsodium-wrappers-sumo'
import { eq } from 'drizzle-orm'
import { agentMessages } from '@memry/db-schema/schema/agent-messages'
import { agentConversations } from '@memry/db-schema/schema/agent-conversations'
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
import { MissingSyncParentError } from '@memry/sync-client/item-handlers/types'
import { encryptConversationTitle } from '../../agent/storage/conversation-store'

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

/**
 * `agent_messages.conversation_id` has no FK, so the parent has to be seeded
 * deliberately: without it the handler now defers the message for orphan repair
 * instead of writing a row nothing can ever reach.
 */
function seedConversation(id: string): void {
  db.insert(agentConversations)
    .values({
      id,
      vaultId: 'vault-1',
      titleCiphertext: encryptConversationTitle('Seeded conversation', vaultKey),
      backend: 'claude_cli',
      backendModel: null,
      trustList: [],
      pinned: false,
      vectorClock: {},
      fieldClocks: {},
      createdAt: 1000,
      updatedAt: 1000,
      deletedAt: null,
      lastSyncedAt: null
    })
    .run()
}

beforeAll(async () => {
  await sodium.ready
  vaultKey = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES)
})

beforeEach(() => {
  db = createTestDataDb()
  seedConversation(CONVERSATION_ID)
  emit.mockClear()
})

describe('agentMessageHandler', () => {
  it('inserts a message whose conversation is already local and notifies the renderer', () => {
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

  it('defers a message that arrives before its conversation instead of orphaning it', () => {
    // conversation_id has no FK, so SQLite would happily write this row — and it
    // would then be unreachable forever, since listByConversation is only called
    // for conversations the UI knows about and an immutable message never gets a
    // later remote update. MissingSyncParentError is the only error the pull
    // coordinator routes into repairOrphans.
    let thrown: unknown
    try {
      agentMessageHandler.applyUpsert(
        ctx(),
        'msg-early',
        payload({ conversationId: 'conv-not-pulled-yet' }),
        { deviceA: 1 }
      )
    } catch (err) {
      thrown = err
    }

    expect(thrown).toBeInstanceOf(MissingSyncParentError)
    expect((thrown as MissingSyncParentError).childType).toBe('agent_message')
    expect((thrown as MissingSyncParentError).childId).toBe('msg-early')
    expect((thrown as MissingSyncParentError).parentType).toBe('agent_conversation')
    expect((thrown as MissingSyncParentError).parentId).toBe('conv-not-pulled-yet')
    expect(
      db.select().from(agentMessages).where(eq(agentMessages.id, 'msg-early')).get()
    ).toBeUndefined()
    expect(emit).not.toHaveBeenCalled()
  })

  it('accepts a message whose conversation is locally tombstoned', () => {
    // repairOrphans asks fetchLocal whether the parent exists, and that returns
    // soft-deleted rows too. Treating a tombstoned conversation as missing here
    // would park the message in a repair loop it can never leave.
    seedConversation('conv-deleted')
    db.update(agentConversations)
      .set({ deletedAt: 2000 })
      .where(eq(agentConversations.id, 'conv-deleted'))
      .run()

    const result = agentMessageHandler.applyUpsert(
      ctx(),
      'msg-2',
      payload({ conversationId: 'conv-deleted' }),
      { deviceA: 1 }
    )

    expect(result).toBe('applied')
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

  it('skips a remote delete whose clock the local row already dominates', () => {
    agentMessageHandler.applyUpsert(ctx(), 'msg-1', payload({ clock: { deviceA: 5 } }), {
      deviceA: 5
    })
    emit.mockClear()

    const result = agentMessageHandler.applyDelete(ctx(), 'msg-1', { deviceA: 2 })

    expect(result).toBe('skipped')
    const row = db.select().from(agentMessages).where(eq(agentMessages.id, 'msg-1')).get()
    expect(row?.deletedAt).toBeNull()
    expect(emit).not.toHaveBeenCalled()
  })

  it('skips a remote delete that is concurrent with the local row', () => {
    agentMessageHandler.applyUpsert(ctx(), 'msg-1', payload(), { deviceA: 3 })
    emit.mockClear()

    const result = agentMessageHandler.applyDelete(ctx(), 'msg-1', { deviceB: 1 })

    expect(result).toBe('skipped')
    const row = db.select().from(agentMessages).where(eq(agentMessages.id, 'msg-1')).get()
    expect(row?.deletedAt).toBeNull()
    expect(emit).not.toHaveBeenCalled()
  })

  it('applies a delete with no clock, so an older peer keeps working', () => {
    agentMessageHandler.applyUpsert(ctx(), 'msg-1', payload(), { deviceA: 1 })
    emit.mockClear()

    expect(agentMessageHandler.applyDelete(ctx(), 'msg-1')).toBe('applied')
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
