import { createHash } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { AgentMessageSyncPayloadSchema } from '@memry/contracts/sync-payloads'
import type { AgentMessageSyncPayload } from '@memry/contracts/sync-payloads'
import { AgentChannels } from '@memry/contracts/ipc-agent'
import type { VectorClock } from '@memry/contracts/sync-api'
import { agentMessages } from '@memry/db-schema/schema/agent-messages'
import type { SyncQueueManager } from '../queue'
import {
  agentMessageRowToModel,
  encryptMessageAttachments,
  encryptMessageContent
} from '../../agent/storage/message-store'
import { TERMINAL_STATUSES } from '../../agent/storage/types'
import type { MessageStatus } from '../../agent/storage/types'
import { createLogger } from '../../lib/logger'
import { BaseItemHandler } from './base-handler'
import type { ApplyContext, ApplyResult, DrizzleDb } from './types'

const log = createLogger('AgentMessageHandler')

interface HandlerDeps {
  vaultKey?: Uint8Array
}

class MissingVaultKeyError extends Error {}

function requireVaultKey(ctx: ApplyContext | undefined, deps: HandlerDeps): Uint8Array {
  const key = deps.vaultKey ?? ctx?.vaultKey
  if (!key) throw new MissingVaultKeyError('Vault key required for agent message sync')
  return key
}

function hashPayload(payload: AgentMessageSyncPayload): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        conversationId: payload.conversationId,
        role: payload.role,
        content: payload.content,
        attachments: payload.attachments,
        toolCallId: payload.toolCallId,
        status: payload.status
      })
    )
    .digest('hex')
}

function plainLocalPayload(
  row: typeof agentMessages.$inferSelect,
  vaultKey: Uint8Array
): AgentMessageSyncPayload {
  const model = agentMessageRowToModel(row, vaultKey)
  return {
    conversationId: model.conversationId,
    role: model.role,
    content: model.content,
    attachments: model.attachments,
    toolCallId: model.toolCallId,
    status: model.status as Extract<MessageStatus, 'completed' | 'cancelled' | 'error'>,
    clock: model.vectorClock,
    createdAt: model.createdAt,
    updatedAt: model.updatedAt,
    deletedAt: model.deletedAt
  }
}

function isTerminal(status: string): boolean {
  return TERMINAL_STATUSES.has(status as MessageStatus)
}

export class AgentMessageHandler extends BaseItemHandler<AgentMessageSyncPayload> {
  readonly type = 'agent_message' as const
  readonly schema = AgentMessageSyncPayloadSchema

  constructor(private readonly deps: HandlerDeps = {}) {
    super()
  }

  applyUpsert(
    ctx: ApplyContext,
    itemId: string,
    data: AgentMessageSyncPayload,
    clock: VectorClock
  ): ApplyResult {
    if (!isTerminal(data.status)) return 'parse_error'

    let vaultKey: Uint8Array
    try {
      vaultKey = requireVaultKey(ctx, this.deps)
    } catch (err) {
      if (err instanceof MissingVaultKeyError) {
        log.warn('Skipping agent message apply without vault key', { itemId })
        return 'skipped'
      }
      throw err
    }

    return ctx.db.transaction((tx): ApplyResult => {
      const existing = tx.select().from(agentMessages).where(eq(agentMessages.id, itemId)).get()
      const remoteClock = Object.keys(clock).length > 0 ? clock : (data.clock ?? {})

      if (!existing) {
        tx.insert(agentMessages)
          .values({
            id: itemId,
            conversationId: data.conversationId,
            role: data.role,
            contentCiphertext: encryptMessageContent(data.content, vaultKey),
            attachmentsCiphertext: encryptMessageAttachments(data.attachments, vaultKey),
            toolCallId: data.toolCallId,
            status: data.status,
            vectorClock: remoteClock,
            createdAt: data.createdAt,
            updatedAt: data.updatedAt,
            deletedAt: data.deletedAt ?? null
          })
          .run()
        ctx.emit(AgentChannels.events.MESSAGES_CHANGED, {
          conversationId: data.conversationId,
          messageId: itemId
        })
        return 'applied'
      }

      const existingPayload = plainLocalPayload(existing, vaultKey)
      if (hashPayload(existingPayload) === hashPayload(data)) return 'skipped'

      log.warn('Message id already exists with different payload', { itemId })
      return 'conflict'
    })
  }

  applyDelete(ctx: ApplyContext, itemId: string, _clock?: VectorClock): 'applied' | 'skipped' {
    const existing = ctx.db.select().from(agentMessages).where(eq(agentMessages.id, itemId)).get()
    if (!existing || existing.deletedAt !== null) return 'skipped'

    ctx.db
      .update(agentMessages)
      .set({ deletedAt: Date.now(), updatedAt: Date.now() })
      .where(eq(agentMessages.id, itemId))
      .run()
    ctx.emit(AgentChannels.events.MESSAGES_CHANGED, {
      conversationId: existing.conversationId,
      messageId: itemId
    })
    return 'applied'
  }

  fetchLocal(db: DrizzleDb, itemId: string): Record<string, unknown> | undefined {
    return db.select().from(agentMessages).where(eq(agentMessages.id, itemId)).get() as
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

    const row = db.select().from(agentMessages).where(eq(agentMessages.id, itemId)).get()
    if (!row || !isTerminal(row.status)) return null

    return JSON.stringify(plainLocalPayload(row, key))
  }
}

export const agentMessageHandler = new AgentMessageHandler()
