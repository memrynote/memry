import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'
import { eq } from 'drizzle-orm'
import { AgentMessageSyncPayloadSchema } from '@memry/contracts/sync-payloads'
import type { AgentMessageSyncPayload } from '@memry/contracts/sync-payloads'
import { AgentChannels } from '@memry/contracts/ipc-agent'
import type { VectorClock } from '@memry/contracts/sync-api'
import { agentMessages } from '@memry/db-schema/schema/agent-messages'
import { agentConversations } from '@memry/db-schema/schema/agent-conversations'
import type { SyncQueueManager } from '@memry/sync-client/queue'
import {
  agentMessageRowToModel,
  encryptMessageAttachments,
  encryptMessageContent
} from '../../agent/storage/message-store'
import { TERMINAL_STATUSES } from '../../agent/storage/types'
import type { MessageStatus } from '../../agent/storage/types'
import { createLogger } from '../../lib/logger'
import { BaseItemHandler } from '@memry/sync-client/item-handlers/base-handler'
import { MissingSyncParentError } from '@memry/sync-client/item-handlers/types'
import type { ApplyContext, ApplyResult, DrizzleDb } from '@memry/sync-client/item-handlers/types'

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
  // Synchronous on purpose: applyUpsert is sync in the handler interface, so
  // WebCrypto's async subtle.digest is not an option on either shell.
  return bytesToHex(
    sha256(
      utf8ToBytes(
        JSON.stringify({
          conversationId: payload.conversationId,
          role: payload.role,
          content: payload.content,
          attachments: payload.attachments,
          toolCallId: payload.toolCallId,
          status: payload.status
        })
      )
    )
  )
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

/**
 * `agent_messages.conversation_id` carries NO foreign key, so — unlike the
 * task/project and calendar work in #837 — SQLite happily writes a message whose
 * conversation has not been pulled yet. The row then exists but belongs to
 * nothing: `listByConversation` is only ever called for a conversation the UI
 * knows about, so the message is invisible forever, and because messages are
 * immutable it never receives a later remote update that could reconcile it.
 *
 * Checking the parent by hand restores the convention the FK-bound handlers get
 * for free: throw `MissingSyncParentError`, which is the only error
 * pull-coordinator routes into `orphanedItems` → `repairOrphans`. That re-fetches
 * the conversation by id (authoritative in a way the pull cursor window is not)
 * and either replays the message once its conversation lands or tombstones it if
 * the conversation is gone everywhere.
 *
 * Backward compatibility: nothing new goes on the wire and no payload written by
 * an older app version is read differently — this only decides whether an
 * out-of-order message is written now or a moment later. Throwing from inside
 * the transaction leaves the DB exactly as it was, and the pull coordinator
 * parks the item in `pendingApplyRetries`, so deferring cannot lose it. A peer
 * on an older build is unaffected: it pushes the same message payload it always
 * did, and its own (unguarded) apply keeps its previous behaviour.
 *
 * Soft-deleted conversations still count as present — `fetchLocal`, which
 * `repairOrphans` uses to decide "parent exists locally", returns tombstoned
 * rows too, so treating them as missing here would spin the repair loop.
 */
function requireConversation(tx: DrizzleDb, messageId: string, conversationId: string): void {
  const parent = tx
    .select({ id: agentConversations.id })
    .from(agentConversations)
    .where(eq(agentConversations.id, conversationId))
    .get()
  if (!parent) {
    throw new MissingSyncParentError(
      'agent_message',
      messageId,
      'agent_conversation',
      conversationId
    )
  }
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
        requireConversation(tx as unknown as DrizzleDb, itemId, data.conversationId)
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

  applyDelete(ctx: ApplyContext, itemId: string, clock?: VectorClock): 'applied' | 'skipped' {
    const existing = ctx.db.select().from(agentMessages).where(eq(agentMessages.id, itemId)).get()
    if (!existing || existing.deletedAt !== null) return 'skipped'

    // Every other handler here gates a remote tombstone on the clock (see
    // bookmark-handler / tag-category-handler); this one accepted it blindly, so
    // a delete could win over a local row the deleting peer had never seen.
    //
    // Backward compatibility: this reads a clock that already travels with every
    // delete envelope — nothing new is emitted, nothing new is required of a
    // peer on an older build, and an absent clock keeps the previous
    // unconditional behaviour. A message is frozen once terminal and only
    // terminal messages sync, so a synced row's clock equals the tombstone's and
    // still resolves to 'apply'; the only newly-skipped case is a row still
    // being written locally, where losing the delete is the correct answer.
    if (clock && existing.vectorClock) {
      const resolution = this.resolveClock(existing.vectorClock, clock)
      if (resolution.action === 'skip' || resolution.action === 'merge') {
        log.info('Skipping remote agent message delete, local has unseen changes', { itemId })
        return 'skipped'
      }
    }

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
