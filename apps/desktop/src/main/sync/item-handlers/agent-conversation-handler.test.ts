import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import sodium from 'libsodium-wrappers-sumo'
import { eq } from 'drizzle-orm'
import { agentConversations } from '@memry/db-schema/schema/agent-conversations'
import { AgentChannels } from '@memry/contracts/ipc-agent'
import type { AgentConversationSyncPayload } from '@memry/contracts/sync-payloads'
import type { FieldClocks, VectorClock } from '@memry/contracts/sync-api'
import { createTestDataDb, type TestDataDb } from '../../../test/helpers/test-data-db'

vi.mock('../../lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

import { agentConversationHandler } from './agent-conversation-handler'
import { decryptConversationTitle } from '../../agent/storage/conversation-store'

const CHANGED = AgentChannels.events.CONVERSATIONS_CHANGED

let db: TestDataDb
let vaultKey: Uint8Array
const emit = vi.fn()

const ctx = (): { db: TestDataDb; emit: typeof emit; vaultKey: Uint8Array } => ({
  db,
  emit,
  vaultKey
})

function payload(
  overrides: Partial<AgentConversationSyncPayload> = {}
): AgentConversationSyncPayload {
  return {
    vaultId: 'vault-1',
    title: 'Remote conversation',
    backend: 'claude_cli',
    backendModel: null,
    trustList: [],
    pinned: false,
    fieldClocks: {},
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides
  }
}

function fieldClocksFor(clock: VectorClock): FieldClocks {
  return {
    title: { ...clock },
    backend: { ...clock },
    backendModel: { ...clock },
    trustList: { ...clock },
    pinned: { ...clock }
  }
}

function titleOf(id: string): string | undefined {
  const row = db.select().from(agentConversations).where(eq(agentConversations.id, id)).get()
  return row ? decryptConversationTitle(row.titleCiphertext, vaultKey) : undefined
}

beforeAll(async () => {
  await sodium.ready
  vaultKey = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES)
})

beforeEach(() => {
  db = createTestDataDb()
  emit.mockClear()
})

describe('agentConversationHandler', () => {
  it('inserts a conversation that does not exist locally and notifies the renderer', () => {
    const result = agentConversationHandler.applyUpsert(ctx(), 'conv-1', payload(), { deviceA: 1 })

    expect(result).toBe('applied')
    expect(titleOf('conv-1')).toBe('Remote conversation')
    expect(emit).toHaveBeenCalledWith(CHANGED, { conversationId: 'conv-1' })
  })

  it('applies a cleanly dominating remote update and notifies the renderer', () => {
    agentConversationHandler.applyUpsert(
      ctx(),
      'conv-1',
      payload({ fieldClocks: fieldClocksFor({ deviceA: 1 }) }),
      { deviceA: 1 }
    )
    emit.mockClear()

    const result = agentConversationHandler.applyUpsert(
      ctx(),
      'conv-1',
      payload({
        title: 'Renamed remotely',
        fieldClocks: fieldClocksFor({ deviceA: 3 }),
        updatedAt: 2000
      }),
      { deviceA: 3 }
    )

    expect(result).toBe('applied')
    expect(titleOf('conv-1')).toBe('Renamed remotely')
    expect(emit).toHaveBeenCalledWith(CHANGED, { conversationId: 'conv-1' })
  })

  it('skips a stale remote update and emits nothing', () => {
    agentConversationHandler.applyUpsert(
      ctx(),
      'conv-1',
      payload({ title: 'Local wins', fieldClocks: fieldClocksFor({ deviceA: 5 }) }),
      { deviceA: 5 }
    )
    emit.mockClear()

    const result = agentConversationHandler.applyUpsert(
      ctx(),
      'conv-1',
      payload({ title: 'Stale remote', fieldClocks: fieldClocksFor({ deviceA: 2 }) }),
      { deviceA: 2 }
    )

    expect(result).toBe('skipped')
    expect(titleOf('conv-1')).toBe('Local wins')
    expect(emit).not.toHaveBeenCalled()
  })

  it('merges concurrent edits, keeps the remote value, and notifies the renderer', () => {
    agentConversationHandler.applyUpsert(
      ctx(),
      'conv-1',
      payload({ title: 'Local title', fieldClocks: fieldClocksFor({ deviceA: 1 }) }),
      { deviceA: 1 }
    )
    emit.mockClear()

    const result = agentConversationHandler.applyUpsert(
      ctx(),
      'conv-1',
      payload({
        title: 'Remote title',
        fieldClocks: fieldClocksFor({ deviceB: 1 }),
        updatedAt: 2000
      }),
      { deviceB: 1 }
    )

    expect(result).toBe('conflict')
    expect(titleOf('conv-1')).toBe('Remote title')
    const row = db
      .select()
      .from(agentConversations)
      .where(eq(agentConversations.id, 'conv-1'))
      .get()
    expect(row?.vectorClock).toEqual({ deviceA: 1, deviceB: 1 })
    expect(emit).toHaveBeenCalledWith(CHANGED, { conversationId: 'conv-1' })
  })

  it('skips a merge that changes no field value and emits nothing', () => {
    agentConversationHandler.applyUpsert(
      ctx(),
      'conv-1',
      payload({ fieldClocks: fieldClocksFor({ deviceA: 1 }) }),
      { deviceA: 1 }
    )
    emit.mockClear()

    const result = agentConversationHandler.applyUpsert(
      ctx(),
      'conv-1',
      payload({ fieldClocks: fieldClocksFor({ deviceB: 1 }) }),
      { deviceB: 1 }
    )

    expect(result).toBe('skipped')
    expect(emit).not.toHaveBeenCalled()
  })

  it('soft-deletes on delete and notifies the renderer', () => {
    agentConversationHandler.applyUpsert(ctx(), 'conv-1', payload(), { deviceA: 1 })
    emit.mockClear()

    const result = agentConversationHandler.applyDelete(ctx(), 'conv-1', { deviceA: 2 })

    expect(result).toBe('applied')
    const row = db
      .select()
      .from(agentConversations)
      .where(eq(agentConversations.id, 'conv-1'))
      .get()
    expect(row?.deletedAt).toBeTruthy()
    expect(emit).toHaveBeenCalledWith(CHANGED, { conversationId: 'conv-1' })
  })

  it('skips a delete for an unknown or already-deleted row and emits nothing', () => {
    expect(agentConversationHandler.applyDelete(ctx(), 'missing', { deviceA: 1 })).toBe('skipped')

    agentConversationHandler.applyUpsert(ctx(), 'conv-1', payload(), { deviceA: 1 })
    agentConversationHandler.applyDelete(ctx(), 'conv-1', { deviceA: 2 })
    emit.mockClear()

    expect(agentConversationHandler.applyDelete(ctx(), 'conv-1', { deviceA: 3 })).toBe('skipped')
    expect(emit).not.toHaveBeenCalled()
  })

  it('returns skipped without emitting when no vault key is available', () => {
    const result = agentConversationHandler.applyUpsert({ db, emit }, 'conv-1', payload(), {
      deviceA: 1
    })

    expect(result).toBe('skipped')
    expect(emit).not.toHaveBeenCalled()
    expect(
      db.select().from(agentConversations).where(eq(agentConversations.id, 'conv-1')).get()
    ).toBeUndefined()
  })
})
