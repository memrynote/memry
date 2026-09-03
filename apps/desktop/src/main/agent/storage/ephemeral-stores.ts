import { randomUUID } from 'node:crypto'

import { TERMINAL_STATUSES, type Conversation, type Message, type VectorClock } from './types'

import type { ConversationStore } from './conversation-store'
import { initAgentConversationFieldClocks, tickClock, tickFieldClocks } from './conversation-store'
import type { MessageStore } from './message-store'

/**
 * Conversation and message stores that never touch the database.
 *
 * Agent Chat's only dependency on the vault key is at-rest encryption of these
 * two tables — the CLI probes, the model catalogue, the MCP server and every
 * tool run need no key material at all. Refusing to start the runtime when the
 * key is unreadable therefore took down a whole feature to protect a transcript,
 * and it happens for reasons the user did not cause: a vault folder opened on a
 * second machine carries a verifier that machine's keychain never wrote, and a
 * dev keychain ACL can reject the read outright.
 *
 * So when the key is unavailable the runtime still starts, against these. The
 * session works end to end; the transcript lives only as long as the process.
 * Writing it under a throwaway key instead would leave rows in a production
 * database that nothing can ever decrypt — worse than not writing them.
 *
 * Callers learn about the downgrade through `historyPersisted: false` on the
 * backend statuses, so the UI can say the transcript will not be kept rather
 * than letting the user find out by restarting.
 */

export function createEphemeralConversationStore(deviceId: string): ConversationStore {
  const conversations = new Map<string, Conversation>()

  const visible = (conversation: Conversation, includeDeleted?: boolean): boolean =>
    includeDeleted === true || conversation.deletedAt === null

  const store: ConversationStore = {
    create({ vaultId, title, backend, backendModel = null }) {
      const now = Date.now()
      const conversation: Conversation = {
        id: randomUUID(),
        vaultId,
        title,
        backend,
        backendModel,
        trustList: [],
        pinned: false,
        vectorClock: { [deviceId]: 1 },
        fieldClocks: initAgentConversationFieldClocks(deviceId),
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        lastSyncedAt: null
      }
      conversations.set(conversation.id, conversation)
      return conversation
    },

    getById(id, opts) {
      const conversation = conversations.get(id)
      if (!conversation || !visible(conversation, opts?.includeDeleted)) return null
      return conversation
    },

    listByVault(vaultId, opts) {
      return [...conversations.values()]
        .filter(
          (conversation) =>
            conversation.vaultId === vaultId && visible(conversation, opts?.includeDeleted)
        )
        .sort((a, b) => b.updatedAt - a.updatedAt)
    },

    update(id, patch, changedFields) {
      const current = conversations.get(id)
      if (!current) throw new Error(`Conversation ${id} not found`)

      const next: Conversation = {
        ...current,
        ...patch,
        vectorClock: tickClock(current.vectorClock, deviceId),
        fieldClocks: tickFieldClocks(current.fieldClocks, deviceId, changedFields),
        updatedAt: Date.now()
      }
      conversations.set(id, next)
      return next
    },

    softDelete(id) {
      const existing = conversations.get(id)
      if (!existing) return
      const now = Date.now()
      conversations.set(id, {
        ...existing,
        deletedAt: now,
        updatedAt: now,
        vectorClock: tickClock(existing.vectorClock, deviceId)
      })
    },

    addToTrustList(id, toolName) {
      const conversation = store.getById(id)
      if (!conversation) throw new Error(`Conversation ${id} not found`)
      if (conversation.trustList.includes(toolName)) return
      store.update(id, { trustList: [...conversation.trustList, toolName] }, ['trustList'])
    },

    removeFromTrustList(id, toolName) {
      const conversation = store.getById(id)
      if (!conversation) throw new Error(`Conversation ${id} not found`)
      if (!conversation.trustList.includes(toolName)) return
      store.update(
        id,
        { trustList: conversation.trustList.filter((trusted) => trusted !== toolName) },
        ['trustList']
      )
    }
  }

  return store
}

export function createEphemeralMessageStore(deviceId: string): MessageStore {
  const messages = new Map<string, Message>()

  const store: MessageStore = {
    append(input) {
      const now = Date.now()
      const vectorClock: VectorClock = { [deviceId]: 1 }
      const message: Message = {
        id: input.id ?? randomUUID(),
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
      messages.set(message.id, message)
      return message
    },

    getById(id) {
      return messages.get(id) ?? null
    },

    listByConversation(conversationId) {
      return [...messages.values()]
        .filter((message) => message.conversationId === conversationId)
        .sort((a, b) => a.createdAt - b.createdAt)
    },

    updateStreaming(id, patch) {
      const existing = store.getById(id)
      if (!existing) throw new Error(`Message ${id} not found`)
      if (TERMINAL_STATUSES.has(existing.status)) {
        throw new Error(`Cannot update terminal message ${id}`)
      }

      const next: Message = {
        ...existing,
        content: patch.content ?? existing.content,
        attachments: patch.attachments ?? existing.attachments,
        vectorClock: tickClock(existing.vectorClock, deviceId),
        updatedAt: Date.now()
      }
      messages.set(id, next)
      return next
    },

    markTerminal(id, status, patch) {
      const existing = store.getById(id)
      if (!existing) throw new Error(`Message ${id} not found`)
      if (TERMINAL_STATUSES.has(existing.status)) {
        throw new Error(`Message ${id} already terminal`)
      }

      const next: Message = {
        ...existing,
        content: patch?.content ?? existing.content,
        attachments: patch?.attachments ?? existing.attachments,
        status,
        vectorClock: tickClock(existing.vectorClock, deviceId),
        updatedAt: Date.now()
      }
      messages.set(id, next)
      return next
    }
  }

  return store
}
