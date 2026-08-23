import { eq } from 'drizzle-orm'
import { AgentConversationSyncPayloadSchema } from '@memry/contracts/sync-payloads'
import type { AgentConversationSyncPayload } from '@memry/contracts/sync-payloads'
import { AgentChannels } from '@memry/contracts/ipc-agent'
import type { FieldClocks, VectorClock } from '@memry/contracts/sync-api'
import { agentConversations } from '@memry/db-schema/schema/agent-conversations'
import type { SyncQueueManager } from '../queue'
import {
  AGENT_CONVERSATION_SYNCABLE_FIELDS,
  type AgentConversationField
} from '@memry/sync-client/agent-conversation-fields'
import { initAllFieldClocks, mergeFields } from '@memry/sync-client/field-merge'
import {
  agentConversationRowToModel,
  encryptConversationTitle
} from '../../agent/storage/conversation-store'
import { createLogger } from '../../lib/logger'
import { BaseItemHandler } from './base-handler'
import type { ApplyContext, ApplyResult, DrizzleDb } from './types'

const log = createLogger('AgentConversationHandler')

interface HandlerDeps {
  vaultKey?: Uint8Array
}

class MissingVaultKeyError extends Error {}

function requireVaultKey(ctx: ApplyContext | undefined, deps: HandlerDeps): Uint8Array {
  const key = deps.vaultKey ?? ctx?.vaultKey
  if (!key) throw new MissingVaultKeyError('Vault key required for agent conversation sync')
  return key
}

function clockIsEmpty(clock: VectorClock): boolean {
  return Object.keys(clock).length === 0
}

function plainLocalPayload(
  row: typeof agentConversations.$inferSelect,
  vaultKey: Uint8Array
): AgentConversationSyncPayload {
  const model = agentConversationRowToModel(row, vaultKey)
  return {
    vaultId: model.vaultId,
    title: model.title,
    backend: model.backend,
    backendModel: model.backendModel,
    trustList: model.trustList,
    pinned: model.pinned,
    clock: model.vectorClock,
    fieldClocks: model.fieldClocks,
    createdAt: model.createdAt,
    updatedAt: model.updatedAt,
    deletedAt: model.deletedAt
  }
}

function fieldValuesEqual(
  left: AgentConversationSyncPayload,
  right: AgentConversationSyncPayload
): boolean {
  return AGENT_CONVERSATION_SYNCABLE_FIELDS.every((field) => {
    return JSON.stringify(left[field]) === JSON.stringify(right[field])
  })
}

function fieldObject(input: AgentConversationSyncPayload): Record<AgentConversationField, unknown> {
  return {
    title: input.title,
    backend: input.backend,
    backendModel: input.backendModel,
    trustList: input.trustList,
    pinned: input.pinned
  }
}

export class AgentConversationHandler extends BaseItemHandler<AgentConversationSyncPayload> {
  readonly type = 'agent_conversation' as const
  readonly schema = AgentConversationSyncPayloadSchema

  constructor(private readonly deps: HandlerDeps = {}) {
    super()
  }

  applyUpsert(
    ctx: ApplyContext,
    itemId: string,
    data: AgentConversationSyncPayload,
    clock: VectorClock
  ): ApplyResult {
    let vaultKey: Uint8Array
    try {
      vaultKey = requireVaultKey(ctx, this.deps)
    } catch (err) {
      if (err instanceof MissingVaultKeyError) {
        log.warn('Skipping agent conversation apply without vault key', { itemId })
        return 'skipped'
      }
      throw err
    }

    return ctx.db.transaction((tx): ApplyResult => {
      const existing = tx
        .select()
        .from(agentConversations)
        .where(eq(agentConversations.id, itemId))
        .get()
      const remoteClock = !clockIsEmpty(clock) ? clock : (data.clock ?? {})
      const remoteFieldClocks = data.fieldClocks
      const now = Date.now()

      if (!existing) {
        tx.insert(agentConversations)
          .values({
            id: itemId,
            vaultId: data.vaultId,
            titleCiphertext: encryptConversationTitle(data.title, vaultKey),
            backend: data.backend,
            backendModel: data.backendModel,
            trustList: data.trustList,
            pinned: data.pinned,
            vectorClock: remoteClock,
            fieldClocks: remoteFieldClocks,
            createdAt: data.createdAt,
            updatedAt: data.updatedAt,
            deletedAt: data.deletedAt ?? null,
            lastSyncedAt: now
          })
          .run()
        ctx.emit(AgentChannels.events.CONVERSATIONS_CHANGED, { conversationId: itemId })
        return 'applied'
      }

      const localPayload = plainLocalPayload(existing, vaultKey)
      const resolution = this.resolveClock(localPayload.clock ?? {}, remoteClock)
      if (resolution.action === 'skip') return 'skipped'

      if (resolution.action === 'merge') {
        const localFieldClocks =
          localPayload.fieldClocks ??
          initAllFieldClocks(localPayload.clock ?? {}, AGENT_CONVERSATION_SYNCABLE_FIELDS)
        const merged = mergeFields(
          fieldObject(localPayload),
          fieldObject(data),
          localFieldClocks,
          remoteFieldClocks,
          AGENT_CONVERSATION_SYNCABLE_FIELDS
        )

        const nextPayload: AgentConversationSyncPayload = {
          ...localPayload,
          title: (merged.merged.title as string | undefined) ?? localPayload.title,
          backend: (merged.merged.backend as string | undefined) ?? localPayload.backend,
          backendModel: Object.hasOwn(merged.merged, 'backendModel')
            ? (merged.merged.backendModel as string | null)
            : localPayload.backendModel,
          trustList: (merged.merged.trustList as string[] | undefined) ?? localPayload.trustList,
          pinned: (merged.merged.pinned as boolean | undefined) ?? localPayload.pinned,
          clock: resolution.mergedClock,
          fieldClocks: merged.mergedFieldClocks,
          updatedAt: Math.max(localPayload.updatedAt, data.updatedAt),
          deletedAt: data.deletedAt ?? localPayload.deletedAt ?? null
        }

        if (fieldValuesEqual(localPayload, nextPayload)) return 'skipped'

        this.writeMerged(tx, itemId, nextPayload, vaultKey, now)
        ctx.emit(AgentChannels.events.CONVERSATIONS_CHANGED, { conversationId: itemId })
        return merged.hadConflicts ? 'conflict' : 'applied'
      }

      const nextPayload: AgentConversationSyncPayload = {
        ...data,
        clock: remoteClock,
        fieldClocks: remoteFieldClocks,
        deletedAt: data.deletedAt ?? null
      }
      this.writeMerged(tx, itemId, nextPayload, vaultKey, now)
      ctx.emit(AgentChannels.events.CONVERSATIONS_CHANGED, { conversationId: itemId })
      return 'applied'
    })
  }

  applyDelete(ctx: ApplyContext, itemId: string, clock?: VectorClock): 'applied' | 'skipped' {
    const existing = ctx.db
      .select()
      .from(agentConversations)
      .where(eq(agentConversations.id, itemId))
      .get()
    if (!existing || existing.deletedAt !== null) return 'skipped'

    if (clock) {
      const resolution = this.resolveClock(existing.vectorClock ?? {}, clock)
      if (resolution.action === 'skip' || resolution.action === 'merge') return 'skipped'
    }

    const now = Date.now()
    ctx.db
      .update(agentConversations)
      .set({ deletedAt: now, updatedAt: now, lastSyncedAt: now })
      .where(eq(agentConversations.id, itemId))
      .run()
    ctx.emit(AgentChannels.events.CONVERSATIONS_CHANGED, { conversationId: itemId })
    return 'applied'
  }

  fetchLocal(db: DrizzleDb, itemId: string): Record<string, unknown> | undefined {
    return db.select().from(agentConversations).where(eq(agentConversations.id, itemId)).get() as
      | Record<string, unknown>
      | undefined
  }

  seedUnclocked(_db: DrizzleDb, _deviceId: string, _queue: SyncQueueManager): number {
    return 0
  }

  buildPushPayload(
    db: DrizzleDb,
    itemId: string,
    _deviceId: string,
    _operation: string,
    vaultKey?: Uint8Array
  ): string | null {
    const key = vaultKey ?? this.deps.vaultKey
    if (!key) return null

    const row = db.select().from(agentConversations).where(eq(agentConversations.id, itemId)).get()
    if (!row) return null

    return JSON.stringify(plainLocalPayload(row, key))
  }

  markPushSynced(db: DrizzleDb, itemId: string): void {
    db.update(agentConversations)
      .set({ lastSyncedAt: Date.now() })
      .where(eq(agentConversations.id, itemId))
      .run()
  }

  private writeMerged(
    db: DrizzleDb,
    itemId: string,
    payload: AgentConversationSyncPayload,
    vaultKey: Uint8Array,
    lastSyncedAt: number
  ): void {
    db.update(agentConversations)
      .set({
        vaultId: payload.vaultId,
        titleCiphertext: encryptConversationTitle(payload.title, vaultKey),
        backend: payload.backend,
        backendModel: payload.backendModel,
        trustList: payload.trustList,
        pinned: payload.pinned,
        vectorClock: payload.clock ?? {},
        fieldClocks: payload.fieldClocks as FieldClocks,
        updatedAt: payload.updatedAt,
        deletedAt: payload.deletedAt ?? null,
        lastSyncedAt
      })
      .where(eq(agentConversations.id, itemId))
      .run()
  }
}

export const agentConversationHandler = new AgentConversationHandler()
