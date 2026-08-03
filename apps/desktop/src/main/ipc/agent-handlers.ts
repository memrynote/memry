import { BrowserWindow, ipcMain, type WebContents } from 'electron'

import {
  AgentBackendIdSchema,
  AgentBackendModelListRequestSchema,
  AgentChannels,
  AgentLocalProviderSettingsUpdateSchema,
  AgentPreferencesUpdateSchema,
  ApproveToolRequestSchema,
  PreviewDiffRequestSchema,
  type AgentBackendOptions,
  type AgentBackendModelList,
  type AgentLocalModelList,
  type AgentLocalProviderProbeResult,
  type AgentLocalProviderSettings,
  type AgentLocalProviderSettingsUpdate,
  type AgentPreferences,
  type AgentPreferencesUpdate,
  type BackendStatusesResponse,
  type PreviewDiffResponse,
  SendTurnRequestSchema
} from '@memry/contracts/ipc-agent'

import { TOOL_SCHEMAS } from '../agent/mcp/tools/schemas'
import { getAgentPreferences, setAgentPreferences } from '../agent/settings'
import type { AgentRuntime } from '../agent/runtime/runtime'
import { acceptDisclosure, getDisclosureState } from '../agent/runtime/disclosure-state'
import { snapshotAttachments } from '../agent/runtime/attachment-snapshotter'
import { runTurn } from '../agent/runtime/turn'
import type { AgentBackendRegistry } from '../agent/backends/registry'
import type { ConversationStore } from '../agent/storage/conversation-store'
import type { MessageStore } from '../agent/storage/message-store'
import type { Conversation, Message } from '../agent/storage/types'
import { broadcastAgentEvent } from '../agent/runtime/event-bus'
import { createLogger } from '../lib/logger'
import { getMainI18n } from '../lib/main-i18n'

const logger = createLogger('IPC:Agent')

const CLI_MODEL_OPTIONS: Record<'claude_cli' | 'codex_cli', AgentBackendModelList> = {
  claude_cli: {
    backend: 'claude_cli',
    supportsCustomModel: true,
    models: [
      { id: 'sonnet', label: 'Sonnet' },
      { id: 'haiku', label: 'Haiku' },
      { id: 'opus', label: 'Opus' }
    ]
  },
  codex_cli: {
    backend: 'codex_cli',
    supportsCustomModel: true,
    models: [
      { id: 'gpt-5.5', label: 'GPT-5.5' },
      { id: 'gpt-5.4', label: 'GPT-5.4' },
      { id: 'gpt-5.4-mini', label: 'GPT-5.4 Mini' }
    ]
  }
}

interface AgentHandlerDeps {
  runtime: Pick<
    AgentRuntime,
    | 'cancelTurn'
    | 'resolveApproval'
    | 'getPendingApproval'
    | 'trackSubprocess'
    | 'untrackSubprocess'
    | 'trackTurn'
    | 'acquireTurnLock'
    | 'releaseTurnLock'
  >
  conversations: ConversationStore
  messages: MessageStore
  backends: AgentBackendRegistry
  previewNoteUpdate: (input: {
    id: string
    mode: 'append' | 'prepend' | 'replace'
    content_markdown: string
  }) => Promise<PreviewDiffResponse>
  localProvider: {
    getSettings: () => Promise<AgentLocalProviderSettings>
    setSettings: (input: AgentLocalProviderSettingsUpdate) => Promise<AgentLocalProviderSettings>
    listModels: () => Promise<AgentLocalModelList>
    testConnection: () => Promise<AgentLocalProviderProbeResult>
    probeTools: () => Promise<AgentLocalProviderProbeResult>
  }
  preferences: {
    get: () => AgentPreferences
    set: (input: AgentPreferencesUpdate) => AgentPreferences
  }
  vaultId: string
}

export function registerAgentHandlers(deps: AgentHandlerDeps): void {
  unregisterAgentHandlers()

  ipcMain.handle(AgentChannels.invoke.LIST_CONVERSATIONS, async (_event, payload: unknown) => {
    const { vaultId = deps.vaultId } = (payload ?? {}) as { vaultId?: string }
    return deps.conversations.listByVault(vaultId)
  })

  ipcMain.handle(AgentChannels.invoke.CREATE_CONVERSATION, async (_event, payload: unknown) => {
    const {
      vaultId = deps.vaultId,
      backend = 'claude_cli',
      backendModel = null
    } = (payload ?? {}) as {
      vaultId?: string
      backend?: string
      backendModel?: string | null
    }
    return deps.conversations.create({
      vaultId,
      title: 'New conversation',
      backend: AgentBackendIdSchema.parse(backend),
      backendModel
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
    try {
      deps.runtime.acquireTurnLock(request.conversationId)
    } catch (error) {
      return {
        ok: false,
        error: extractErrorMessage(error, getMainI18n().t('errors:agent.conversationBusy'))
      }
    }

    const attachments = await snapshotAttachments(request.attachments)
    const conversation = deps.conversations.getById(request.conversationId)
    const backendModel = await backendModelFromOptions(request.backendOptions, deps)
    if (
      conversation &&
      (conversation.backend !== request.backendOptions.backend ||
        conversation.backendModel !== backendModel)
    ) {
      const messages = deps.messages.listByConversation(request.conversationId)
      const changedFields =
        conversation.backend !== request.backendOptions.backend
          ? (['backend', 'backendModel'] as const)
          : (['backendModel'] as const)
      const updated = deps.conversations.update(
        request.conversationId,
        { backend: request.backendOptions.backend, backendModel },
        [...changedFields]
      )
      if (messages.length > 0) {
        const systemMessage = deps.messages.append({
          conversationId: request.conversationId,
          role: 'system',
          content: {
            role: 'system',
            data: {
              kind: 'backend_changed',
              payload: {
                from: conversation.backend,
                to: request.backendOptions.backend,
                model: backendModel
              }
            }
          },
          attachments: [],
          status: 'completed'
        })
        broadcastMessage(systemMessage)
      }
      broadcastConversation(updated)
    }

    const turn = runTurn(
      {
        conversations: deps.conversations,
        messages: deps.messages,
        backends: deps.backends,
        trackRunHandle: (conversationId, subprocess) => {
          deps.runtime.trackSubprocess(conversationId, subprocess)
          return {
            ...subprocess,
            cleanup: async () => {
              try {
                await subprocess.cleanup()
              } finally {
                deps.runtime.untrackSubprocess(subprocess.pid)
              }
            }
          }
        }
      },
      {
        conversationId: request.conversationId,
        sourceWindowId: request.sourceWindowId,
        text: request.text,
        backendOptions: request.backendOptions,
        permissions: request.permissions,
        attachments
      }
    )
      .catch((error) => {
        logger.error('Agent turn failed', error)
      })
      .finally(() => {
        deps.runtime.releaseTurnLock(request.conversationId)
      })
    deps.runtime.trackTurn(request.conversationId, turn)
    void turn

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

  ipcMain.handle(AgentChannels.invoke.PREVIEW_DIFF, async (_event, payload: unknown) => {
    const request = PreviewDiffRequestSchema.parse(payload)
    const pending = deps.runtime.getPendingApproval(request.toolCallId)
    if (!pending || pending.conversationId !== request.conversationId) {
      throw new Error('No pending approval found for diff preview')
    }
    if (pending.name !== 'vault_update_note' || !pending.requiresDiff) {
      throw new Error('Diff preview is only available for vault_update_note approvals')
    }

    const parsed = TOOL_SCHEMAS.vault_update_note.input.safeParse(pending.args)
    if (!parsed.success) {
      throw new Error('Pending approval has invalid vault_update_note arguments')
    }

    return deps.previewNoteUpdate(parsed.data)
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

  ipcMain.handle(AgentChannels.invoke.GET_BACKEND_STATUSES, () => getBackendStatuses(deps))
  ipcMain.handle(AgentChannels.invoke.LIST_BACKEND_MODELS, async (_event, payload: unknown) => {
    const request = AgentBackendModelListRequestSchema.parse(payload)
    return CLI_MODEL_OPTIONS[request.backend]
  })
  ipcMain.handle(AgentChannels.invoke.GET_LOCAL_PROVIDER_SETTINGS, () =>
    deps.localProvider.getSettings()
  )
  ipcMain.handle(AgentChannels.invoke.SET_LOCAL_PROVIDER_SETTINGS, (_event, payload: unknown) => {
    return deps.localProvider.setSettings(AgentLocalProviderSettingsUpdateSchema.parse(payload))
  })
  ipcMain.handle(AgentChannels.invoke.GET_PREFERENCES, async () => deps.preferences.get())
  ipcMain.handle(AgentChannels.invoke.SET_PREFERENCES, async (_event, payload: unknown) => {
    return deps.preferences.set(AgentPreferencesUpdateSchema.parse(payload))
  })
  ipcMain.handle(AgentChannels.invoke.LIST_LOCAL_MODELS, () => deps.localProvider.listModels())
  ipcMain.handle(AgentChannels.invoke.TEST_LOCAL_PROVIDER, () =>
    deps.localProvider.testConnection()
  )
  ipcMain.handle(AgentChannels.invoke.PROBE_LOCAL_PROVIDER, () => deps.localProvider.probeTools())
  ipcMain.handle(AgentChannels.invoke.GET_DISCLOSURE_STATE, () => getDisclosureState())
  ipcMain.handle(AgentChannels.invoke.ACCEPT_DISCLOSURE, () => acceptDisclosure())
  ipcMain.handle(AgentChannels.invoke.GET_WINDOW_ID, (event) => ({
    windowId: resolveSenderWindowId(event.sender)
  }))
}

export function registerUnavailableAgentHandlers(reason: string): void {
  const message = `Agent runtime unavailable: ${reason}`
  const unavailable = (): never => {
    throw new Error(message)
  }

  unregisterAgentHandlers()

  registerUnavailableHandler(AgentChannels.invoke.LIST_CONVERSATIONS, async () => [])
  registerUnavailableHandler(AgentChannels.invoke.CREATE_CONVERSATION, async () => unavailable())
  registerUnavailableHandler(AgentChannels.invoke.LOAD_CONVERSATION, async () => unavailable())
  registerUnavailableHandler(AgentChannels.invoke.SEND_TURN, async () => ({
    ok: false,
    error: message
  }))
  registerUnavailableHandler(AgentChannels.invoke.CANCEL_TURN, async () => unavailable())
  registerUnavailableHandler(AgentChannels.invoke.APPROVE_TOOL, async () => unavailable())
  registerUnavailableHandler(AgentChannels.invoke.PREVIEW_DIFF, async () => unavailable())
  registerUnavailableHandler(AgentChannels.invoke.EDIT_TRUST_LIST, async () => unavailable())
  registerUnavailableHandler(AgentChannels.invoke.GET_BACKEND_STATUSES, async () => ({
    claude_cli: {
      backend: 'claude_cli',
      available: false,
      reason: 'agent_unavailable',
      detail: message
    },
    codex_cli: {
      backend: 'codex_cli',
      available: false,
      reason: 'agent_unavailable',
      detail: message
    },
    local_openai_compatible: {
      backend: 'local_openai_compatible',
      available: false,
      reason: 'agent_unavailable',
      detail: message
    }
  }))
  registerUnavailableHandler(AgentChannels.invoke.LIST_BACKEND_MODELS, (_event, payload) => {
    const request = AgentBackendModelListRequestSchema.parse(payload)
    return CLI_MODEL_OPTIONS[request.backend]
  })
  registerUnavailableHandler(AgentChannels.invoke.GET_LOCAL_PROVIDER_SETTINGS, async () =>
    unavailable()
  )
  registerUnavailableHandler(AgentChannels.invoke.SET_LOCAL_PROVIDER_SETTINGS, async () =>
    unavailable()
  )
  registerUnavailableHandler(AgentChannels.invoke.GET_PREFERENCES, () => getAgentPreferences())
  registerUnavailableHandler(AgentChannels.invoke.SET_PREFERENCES, (_event, payload) => {
    return setAgentPreferences(AgentPreferencesUpdateSchema.parse(payload))
  })
  registerUnavailableHandler(AgentChannels.invoke.LIST_LOCAL_MODELS, async () => unavailable())
  registerUnavailableHandler(AgentChannels.invoke.TEST_LOCAL_PROVIDER, async () => unavailable())
  registerUnavailableHandler(AgentChannels.invoke.PROBE_LOCAL_PROVIDER, async () => unavailable())
  registerUnavailableHandler(AgentChannels.invoke.GET_DISCLOSURE_STATE, () => getDisclosureState())
  registerUnavailableHandler(AgentChannels.invoke.ACCEPT_DISCLOSURE, () => acceptDisclosure())
  registerUnavailableHandler(AgentChannels.invoke.GET_WINDOW_ID, (event) => ({
    windowId: resolveSenderWindowId(event.sender)
  }))
}

export function unregisterAgentHandlers(): void {
  for (const channel of Object.values(AgentChannels.invoke)) {
    ipcMain.removeHandler(channel)
  }
}

function registerUnavailableHandler(
  channel: string,
  handler: Parameters<typeof ipcMain.handle>[1]
): void {
  ipcMain.handle(channel, handler)
}

function extractErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

async function backendModelFromOptions(
  options: AgentBackendOptions,
  deps: AgentHandlerDeps
): Promise<string | null> {
  if (options.backend === 'claude_cli' || options.backend === 'codex_cli') {
    return options.model ?? null
  }
  if (options.model) return options.model
  const settings = await deps.localProvider.getSettings()
  return settings.model || null
}

async function getBackendStatuses(deps: AgentHandlerDeps): Promise<BackendStatusesResponse> {
  const [claude, codex, local] = await Promise.all([
    deps.backends.get('claude_cli').getStatus(),
    deps.backends.get('codex_cli').getStatus(),
    deps.backends.get('local_openai_compatible').getStatus()
  ])
  return {
    claude_cli: claude,
    codex_cli: codex,
    local_openai_compatible: local
  }
}

function broadcastMessage(message: Message): void {
  broadcastAgentEvent({ kind: 'message_upserted', message })
}

function broadcastConversation(conversation: Conversation): void {
  broadcastAgentEvent({ kind: 'conversation_updated', conversation })
}

function resolveSenderWindowId(sender: WebContents): string | null {
  const direct = BrowserWindow.fromWebContents(sender)
  if (direct) return direct.id.toString()

  const windows = BrowserWindow.getAllWindows()
  const matchingWindow = windows.find((win) => win.webContents.id === sender.id)
  if (matchingWindow) return matchingWindow.id.toString()
  if (windows.length === 1) return windows[0].id.toString()
  return null
}
