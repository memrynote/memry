import { ipcMain } from 'electron'

import {
  AgentChannels,
  ApproveToolRequestSchema,
  SendTurnRequestSchema
} from '@memry/contracts/ipc-agent'

import { detectClaudeBinary } from '../agent/cli/claude-binary'
import type { AgentRuntime } from '../agent/runtime/runtime'
import { acceptDisclosure, getDisclosureState } from '../agent/runtime/disclosure-state'
import { snapshotAttachments } from '../agent/runtime/attachment-snapshotter'
import { runTurn, type TurnDeps } from '../agent/runtime/turn'
import type { ConversationStore } from '../agent/storage/conversation-store'
import type { MessageStore } from '../agent/storage/message-store'
import { createLogger } from '../lib/logger'

const logger = createLogger('IPC:Agent')

interface AgentHandlerDeps {
  runtime: Pick<AgentRuntime, 'cancelTurn' | 'resolveApproval'>
  conversations: ConversationStore
  messages: MessageStore
  spawn: TurnDeps['spawnSubprocess']
  routeToolCall: TurnDeps['toolHandlers']['routeToolCall']
  vaultId: string
}

export function registerAgentHandlers(deps: AgentHandlerDeps): void {
  ipcMain.handle(AgentChannels.invoke.LIST_CONVERSATIONS, async (_event, payload: unknown) => {
    const { vaultId = deps.vaultId } = (payload ?? {}) as { vaultId?: string }
    return deps.conversations.listByVault(vaultId)
  })

  ipcMain.handle(AgentChannels.invoke.CREATE_CONVERSATION, async (_event, payload: unknown) => {
    const { vaultId = deps.vaultId, backend = 'claude_cli' } = (payload ?? {}) as {
      vaultId?: string
      backend?: string
    }
    return deps.conversations.create({
      vaultId,
      title: 'New conversation',
      backend
    })
  })

  ipcMain.handle(AgentChannels.invoke.LOAD_CONVERSATION, async (_event, payload: unknown) => {
    const { id } = payload as { id: string }
    const conversation = deps.conversations.getById(id)
    const messages = deps.messages.listByConversation(id)
    return { conversation, messages }
  })

  ipcMain.handle(AgentChannels.invoke.SEND_TURN, async (_event, payload: unknown) => {
    const request = SendTurnRequestSchema.parse(payload)
    const attachments = await snapshotAttachments(request.attachments)

    void runTurn(
      {
        conversations: deps.conversations,
        messages: deps.messages,
        spawnSubprocess: deps.spawn,
        toolHandlers: { routeToolCall: deps.routeToolCall }
      },
      {
        conversationId: request.conversationId,
        sourceWindowId: request.sourceWindowId,
        text: request.text,
        attachments
      }
    ).catch((error) => {
      logger.error('Agent turn failed', error)
    })

    return { ok: true }
  })

  ipcMain.handle(AgentChannels.invoke.CANCEL_TURN, async (_event, payload: unknown) => {
    const { conversationId } = payload as { conversationId: string }
    deps.runtime.cancelTurn(conversationId)
    return { ok: true }
  })

  ipcMain.handle(AgentChannels.invoke.APPROVE_TOOL, async (_event, payload: unknown) => {
    const request = ApproveToolRequestSchema.parse(payload)
    deps.runtime.resolveApproval(request.toolCallId, request.decision)
    return { ok: true }
  })

  ipcMain.handle(AgentChannels.invoke.EDIT_TRUST_LIST, async (_event, payload: unknown) => {
    const { conversationId, add, remove } = (payload ?? {}) as {
      conversationId: string
      add?: string[]
      remove?: string[]
    }
    for (const toolName of add ?? []) {
      deps.conversations.addToTrustList(conversationId, toolName)
    }
    for (const toolName of remove ?? []) {
      deps.conversations.removeFromTrustList(conversationId, toolName)
    }
    return deps.conversations.getById(conversationId)
  })

  ipcMain.handle(AgentChannels.invoke.GET_BINARY_STATUS, () => detectClaudeBinary())
  ipcMain.handle(AgentChannels.invoke.GET_DISCLOSURE_STATE, () => getDisclosureState())
  ipcMain.handle(AgentChannels.invoke.ACCEPT_DISCLOSURE, () => acceptDisclosure())
}

export function unregisterAgentHandlers(): void {
  for (const channel of Object.values(AgentChannels.invoke)) {
    ipcMain.removeHandler(channel)
  }
}
