import { randomUUID } from 'node:crypto'
import { and, desc, eq, isNull } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'

import * as schema from '@memry/db-schema/data-schema'

import { createLogger } from '../../lib/logger'
import { trackMainError } from '../../telemetry/diagnostics'
import {
  AGENT_CONVERSATION_SYNCABLE_FIELDS,
  type AgentConversationField
} from '@memry/sync-client/agent-conversation-fields'
import { decryptAgentJsonForVault, encryptAgentJsonForVault } from './encryption'
import type { AgentBackendId } from '@memry/contracts/ipc-agent'

import type { Conversation, FieldClocks, VectorClock } from './types'

const logger = createLogger('AgentConversationStore')

interface StoreDeps {
  db: BetterSQLite3Database<typeof schema>
  vaultKey: Uint8Array
  deviceId: string
}

export interface ConversationStore {
  create(input: {
    vaultId: string
    title: string
    backend: AgentBackendId
    backendModel?: string | null
  }): Conversation
  getById(id: string, opts?: { includeDeleted?: boolean }): Conversation | null
  listByVault(vaultId: string, opts?: { includeDeleted?: boolean }): Conversation[]
  update(
    id: string,
    patch: Partial<
      Pick<Conversation, 'title' | 'pinned' | 'backend' | 'backendModel' | 'trustList'>
    >,
    changedFields: AgentConversationField[]
  ): Conversation
  softDelete(id: string): void
  addToTrustList(id: string, toolName: string): void
  removeFromTrustList(id: string, toolName: string): void
}

export function initAgentConversationFieldClocks(deviceId: string): FieldClocks {
  return Object.fromEntries(
    AGENT_CONVERSATION_SYNCABLE_FIELDS.map((field) => [field, { [deviceId]: 1 }])
  )
}

export function encryptConversationTitle(title: string, vaultKey: Uint8Array): string {
  return JSON.stringify(encryptAgentJsonForVault(title, vaultKey, 'agent_conversation_title'))
}

export function decryptConversationTitle(titleCiphertext: string, vaultKey: Uint8Array): string {
  return decryptAgentJsonForVault(JSON.parse(titleCiphertext), vaultKey, 'agent_conversation_title')
}

export function agentConversationRowToModel(
  row: schema.AgentConversationRow,
  vaultKey: Uint8Array
): Conversation {
  return {
    id: row.id,
    vaultId: row.vaultId,
    title: decryptConversationTitle(row.titleCiphertext, vaultKey),
    backend: row.backend as AgentBackendId,
    backendModel: row.backendModel ?? null,
    trustList: parseJsonColumn(row.trustList, []),
    pinned: Boolean(row.pinned),
    vectorClock: parseJsonColumn(row.vectorClock, {}),
    fieldClocks: parseJsonColumn(row.fieldClocks, {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
    lastSyncedAt: row.lastSyncedAt
  }
}

function parseJsonColumn<T>(value: T | string | null, fallback: T): T {
  if (value === null) return fallback
  if (typeof value !== 'string') return value
  return JSON.parse(value) as T
}

function tickClock(clock: VectorClock, deviceId: string): VectorClock {
  return { ...clock, [deviceId]: (clock[deviceId] ?? 0) + 1 }
}

function tickFieldClocks(
  fieldClocks: FieldClocks,
  deviceId: string,
  fields: readonly AgentConversationField[]
): FieldClocks {
  const next: FieldClocks = { ...fieldClocks }
  for (const field of fields) next[field] = tickClock(fieldClocks[field] ?? {}, deviceId)
  return next
}

export function createConversationStore(deps: StoreDeps): ConversationStore {
  const { db, vaultKey, deviceId } = deps

  return {
    create({ vaultId, title, backend, backendModel = null }) {
      const id = randomUUID()
      const now = Date.now()
      const vectorClock: VectorClock = { [deviceId]: 1 }
      const fieldClocks = initAgentConversationFieldClocks(deviceId)

      db.insert(schema.agentConversations)
        .values({
          id,
          vaultId,
          titleCiphertext: encryptConversationTitle(title, vaultKey),
          backend,
          backendModel,
          trustList: [],
          pinned: false,
          vectorClock,
          fieldClocks,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
          lastSyncedAt: null
        })
        .run()

      return {
        id,
        vaultId,
        title,
        backend,
        backendModel,
        trustList: [],
        pinned: false,
        vectorClock,
        fieldClocks,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        lastSyncedAt: null
      }
    },

    getById(id, opts) {
      // Tombstoned rows are hidden by default, exactly like `listByVault`.
      // `getById` is the existence gate the MCP write gate and the IPC handlers
      // read, so a row carrying `deletedAt` must not answer "yes, write here" —
      // an inbound remote delete can set that tombstone without this device
      // ever touching the row.
      const where = opts?.includeDeleted
        ? eq(schema.agentConversations.id, id)
        : and(eq(schema.agentConversations.id, id), isNull(schema.agentConversations.deletedAt))

      const row = db.select().from(schema.agentConversations).where(where).get()
      return row ? agentConversationRowToModel(row, vaultKey) : null
    },

    listByVault(vaultId, opts) {
      const where = opts?.includeDeleted
        ? eq(schema.agentConversations.vaultId, vaultId)
        : and(
            eq(schema.agentConversations.vaultId, vaultId),
            isNull(schema.agentConversations.deletedAt)
          )

      const rows = db
        .select()
        .from(schema.agentConversations)
        .where(where)
        .orderBy(desc(schema.agentConversations.updatedAt))
        .all()

      return rows.flatMap((row) => {
        try {
          return [agentConversationRowToModel(row, vaultKey)]
        } catch (error) {
          // Wrong vault key, corrupt row, or cross-device sync artifact: keep
          // the rest of the list rendering, but a conversation silently
          // vanishing here is exactly what support tickets look like.
          logger.warn(`Dropping undecryptable agent conversation row ${row.id}`, error)
          trackMainError('agent', 'conversation_decrypt', error)
          return []
        }
      })
    },

    update(id, patch, changedFields) {
      const existing = db
        .select()
        .from(schema.agentConversations)
        .where(eq(schema.agentConversations.id, id))
        .get()
      if (!existing) throw new Error(`Conversation ${id} not found`)

      const current = agentConversationRowToModel(existing, vaultKey)
      const next: Conversation = {
        ...current,
        ...patch,
        vectorClock: tickClock(current.vectorClock, deviceId),
        fieldClocks: tickFieldClocks(current.fieldClocks, deviceId, changedFields),
        updatedAt: Date.now()
      }

      db.update(schema.agentConversations)
        .set({
          titleCiphertext:
            patch.title === undefined
              ? existing.titleCiphertext
              : encryptConversationTitle(patch.title, vaultKey),
          backend: next.backend,
          backendModel: next.backendModel,
          trustList: next.trustList,
          pinned: next.pinned,
          vectorClock: next.vectorClock,
          fieldClocks: next.fieldClocks,
          updatedAt: next.updatedAt
        })
        .where(eq(schema.agentConversations.id, id))
        .run()

      return next
    },

    softDelete(id) {
      // Opt in to the tombstoned row: re-deleting has always re-stamped
      // `deletedAt` and ticked the clock, and this keeps that behaviour.
      // NOTE: this still has no production caller. Whoever wires conversation
      // delete to the UI must also cancel any in-flight turn for the
      // conversation (`AgentRuntime.cancelTurn`), or the run keeps writing into
      // a record the user believes is gone.
      const existing = this.getById(id, { includeDeleted: true })
      if (!existing) return
      const now = Date.now()
      db.update(schema.agentConversations)
        .set({
          deletedAt: now,
          updatedAt: now,
          vectorClock: tickClock(existing.vectorClock, deviceId)
        })
        .where(eq(schema.agentConversations.id, id))
        .run()
    },

    addToTrustList(id, toolName) {
      const conversation = this.getById(id)
      if (!conversation) throw new Error(`Conversation ${id} not found`)
      if (conversation.trustList.includes(toolName)) return
      this.update(id, { trustList: [...conversation.trustList, toolName] }, ['trustList'])
    },

    removeFromTrustList(id, toolName) {
      const conversation = this.getById(id)
      if (!conversation) throw new Error(`Conversation ${id} not found`)
      if (!conversation.trustList.includes(toolName)) return
      this.update(
        id,
        { trustList: conversation.trustList.filter((trustedTool) => trustedTool !== toolName) },
        ['trustList']
      )
    }
  }
}
