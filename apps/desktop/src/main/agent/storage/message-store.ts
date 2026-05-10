import { randomUUID } from 'node:crypto'
import { asc, eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'

import * as schema from '@memry/db-schema/data-schema'

import { decryptAgentJsonForVault, encryptAgentJsonForVault } from './encryption'
import {
  MessageAttachmentSchema,
  MessageContentSchema,
  TERMINAL_STATUSES,
  type Message,
  type MessageAttachment,
  type MessageContent,
  type MessageRole,
  type MessageStatus,
  type VectorClock
} from './types'

type TerminalMessageStatus = Extract<MessageStatus, 'completed' | 'cancelled' | 'error'>

interface StoreDeps {
  db: BetterSQLite3Database<typeof schema>
  vaultKey: Uint8Array
  deviceId: string
}

export interface MessageStore {
  append(input: {
    conversationId: string
    role: MessageRole
    content: MessageContent
    attachments: MessageAttachment[]
    status: MessageStatus
    toolCallId?: string | null
    id?: string
  }): Message
  getById(id: string): Message | null
  listByConversation(conversationId: string): Message[]
  updateStreaming(
    id: string,
    patch: { content?: MessageContent; attachments?: MessageAttachment[] }
  ): Message
  markTerminal(
    id: string,
    status: TerminalMessageStatus,
    patch?: { content?: MessageContent; attachments?: MessageAttachment[] }
  ): Message
}

export function encryptMessageContent(content: MessageContent, vaultKey: Uint8Array): string {
  return JSON.stringify(
    encryptAgentJsonForVault(JSON.stringify(content), vaultKey, 'agent_message_content')
  )
}

export function encryptMessageAttachments(
  attachments: MessageAttachment[],
  vaultKey: Uint8Array
): string {
  return JSON.stringify(
    encryptAgentJsonForVault(JSON.stringify(attachments), vaultKey, 'agent_attachments')
  )
}

export function decryptMessageContent(
  contentCiphertext: string,
  vaultKey: Uint8Array
): MessageContent {
  const plaintext = decryptAgentJsonForVault(
    JSON.parse(contentCiphertext),
    vaultKey,
    'agent_message_content'
  )
  return MessageContentSchema.parse(JSON.parse(plaintext))
}

export function decryptMessageAttachments(
  attachmentsCiphertext: string,
  vaultKey: Uint8Array
): MessageAttachment[] {
  const plaintext = decryptAgentJsonForVault(
    JSON.parse(attachmentsCiphertext),
    vaultKey,
    'agent_attachments'
  )
  return MessageAttachmentSchema.array().parse(JSON.parse(plaintext))
}

export function agentMessageRowToModel(row: schema.AgentMessageRow, vaultKey: Uint8Array): Message {
  return {
    id: row.id,
    conversationId: row.conversationId,
    role: row.role as MessageRole,
    content: decryptMessageContent(row.contentCiphertext, vaultKey),
    toolCallId: row.toolCallId,
    attachments: decryptMessageAttachments(row.attachmentsCiphertext, vaultKey),
    status: row.status as MessageStatus,
    vectorClock: parseJsonColumn(row.vectorClock, {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt
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

function assertContentRole(role: MessageRole, content: MessageContent): void {
  if (content.role !== role) {
    throw new Error(`Message content role ${content.role} does not match row role ${role}`)
  }
}

export function createMessageStore(deps: StoreDeps): MessageStore {
  const { db, vaultKey, deviceId } = deps

  function writeRow(message: Message): void {
    db.update(schema.agentMessages)
      .set({
        contentCiphertext: encryptMessageContent(message.content, vaultKey),
        attachmentsCiphertext: encryptMessageAttachments(message.attachments, vaultKey),
        status: message.status,
        vectorClock: message.vectorClock,
        updatedAt: message.updatedAt
      })
      .where(eq(schema.agentMessages.id, message.id))
      .run()
  }

  return {
    append(input) {
      assertContentRole(input.role, input.content)
      const id = input.id ?? randomUUID()
      const now = Date.now()
      const vectorClock: VectorClock = { [deviceId]: 1 }

      db.insert(schema.agentMessages)
        .values({
          id,
          conversationId: input.conversationId,
          role: input.role,
          contentCiphertext: encryptMessageContent(input.content, vaultKey),
          attachmentsCiphertext: encryptMessageAttachments(input.attachments, vaultKey),
          toolCallId: input.toolCallId ?? null,
          status: input.status,
          vectorClock,
          createdAt: now,
          updatedAt: now,
          deletedAt: null
        })
        .run()

      return {
        id,
        conversationId: input.conversationId,
        role: input.role,
        content: input.content,
        toolCallId: input.toolCallId ?? null,
        attachments: input.attachments,
        status: input.status,
        vectorClock,
        createdAt: now,
        updatedAt: now,
        deletedAt: null
      }
    },

    getById(id) {
      const row = db
        .select()
        .from(schema.agentMessages)
        .where(eq(schema.agentMessages.id, id))
        .get()
      return row ? agentMessageRowToModel(row, vaultKey) : null
    },

    listByConversation(conversationId) {
      const rows = db
        .select()
        .from(schema.agentMessages)
        .where(eq(schema.agentMessages.conversationId, conversationId))
        .orderBy(asc(schema.agentMessages.createdAt))
        .all()
      return rows.map((row) => agentMessageRowToModel(row, vaultKey))
    },

    updateStreaming(id, patch) {
      const existing = this.getById(id)
      if (!existing) throw new Error(`Message ${id} not found`)
      if (TERMINAL_STATUSES.has(existing.status)) {
        throw new Error(`Cannot update terminal message ${id}`)
      }

      const content = patch.content ?? existing.content
      assertContentRole(existing.role, content)
      const next: Message = {
        ...existing,
        content,
        attachments: patch.attachments ?? existing.attachments,
        vectorClock: tickClock(existing.vectorClock, deviceId),
        updatedAt: Date.now()
      }
      writeRow(next)
      return next
    },

    markTerminal(id, status, patch) {
      const existing = this.getById(id)
      if (!existing) throw new Error(`Message ${id} not found`)
      if (TERMINAL_STATUSES.has(existing.status)) {
        throw new Error(`Message ${id} already terminal`)
      }

      const content = patch?.content ?? existing.content
      assertContentRole(existing.role, content)
      const next: Message = {
        ...existing,
        content,
        attachments: patch?.attachments ?? existing.attachments,
        status,
        vectorClock: tickClock(existing.vectorClock, deviceId),
        updatedAt: Date.now()
      }
      writeRow(next)
      return next
    }
  }
}
