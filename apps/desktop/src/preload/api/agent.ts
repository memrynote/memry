import type {
  AgentEvent,
  AgentBackendId,
  AgentBackendModelList,
  AgentBackendModelListRequest,
  AgentLocalModelList,
  AgentLocalProviderProbeResult,
  AgentLocalProviderSettings,
  AgentLocalProviderSettingsUpdate,
  AgentPreferences,
  AgentPreferencesUpdate,
  AgentStreamTargetRequest,
  ApproveToolRequest,
  BackendStatusesResponse,
  PreviewDiffRequest,
  PreviewDiffResponse,
  SendTurnRequest,
  SendTurnResponse,
  Conversation,
  Message
} from '@memry/contracts/ipc-agent'
import { AgentChannels } from '@memry/contracts/ipc-agent'
import { invoke, subscribe } from '../lib/ipc'

export const agentApi = {
  listConversations: (input?: { vaultId?: string }): Promise<Conversation[]> =>
    invoke(AgentChannels.invoke.LIST_CONVERSATIONS, input),
  createConversation: (input?: {
    vaultId?: string
    backend?: AgentBackendId
    backendModel?: string | null
  }): Promise<Conversation> => invoke(AgentChannels.invoke.CREATE_CONVERSATION, input),
  loadConversation: (input: {
    id: string
  }): Promise<{
    conversation: Conversation | null
    messages: Message[]
  }> => invoke(AgentChannels.invoke.LOAD_CONVERSATION, input),
  sendTurn: (input: SendTurnRequest): Promise<SendTurnResponse> =>
    invoke(AgentChannels.invoke.SEND_TURN, input),
  cancelTurn: (input: { conversationId: string }): Promise<{ ok: boolean }> =>
    invoke(AgentChannels.invoke.CANCEL_TURN, input),
  approveTool: (input: ApproveToolRequest): Promise<{ ok: boolean }> =>
    invoke(AgentChannels.invoke.APPROVE_TOOL, input),
  previewDiff: (input: PreviewDiffRequest): Promise<PreviewDiffResponse> =>
    invoke(AgentChannels.invoke.PREVIEW_DIFF, input),
  editTrustList: (input: {
    conversationId: string
    add?: string[]
    remove?: string[]
  }): Promise<Conversation | null> => invoke(AgentChannels.invoke.EDIT_TRUST_LIST, input),
  getBackendStatuses: (): Promise<BackendStatusesResponse> =>
    invoke(AgentChannels.invoke.GET_BACKEND_STATUSES),
  listBackendModels: (input: AgentBackendModelListRequest): Promise<AgentBackendModelList> =>
    invoke(AgentChannels.invoke.LIST_BACKEND_MODELS, input),
  getLocalProviderSettings: (): Promise<AgentLocalProviderSettings> =>
    invoke(AgentChannels.invoke.GET_LOCAL_PROVIDER_SETTINGS),
  setLocalProviderSettings: (
    input: AgentLocalProviderSettingsUpdate
  ): Promise<AgentLocalProviderSettings> =>
    invoke(AgentChannels.invoke.SET_LOCAL_PROVIDER_SETTINGS, input),
  getPreferences: (): Promise<AgentPreferences> => invoke(AgentChannels.invoke.GET_PREFERENCES),
  setPreferences: (input: AgentPreferencesUpdate): Promise<AgentPreferences> =>
    invoke(AgentChannels.invoke.SET_PREFERENCES, input),
  listLocalModels: (): Promise<AgentLocalModelList> =>
    invoke(AgentChannels.invoke.LIST_LOCAL_MODELS),
  testLocalProvider: (): Promise<AgentLocalProviderProbeResult> =>
    invoke(AgentChannels.invoke.TEST_LOCAL_PROVIDER),
  probeLocalProvider: (): Promise<AgentLocalProviderProbeResult> =>
    invoke(AgentChannels.invoke.PROBE_LOCAL_PROVIDER),
  acceptDisclosure: (): Promise<{ accepted: boolean }> =>
    invoke(AgentChannels.invoke.ACCEPT_DISCLOSURE),
  getDisclosureState: (): Promise<{ accepted: boolean }> =>
    invoke(AgentChannels.invoke.GET_DISCLOSURE_STATE),
  getWindowId: (): Promise<{ windowId: string | null }> =>
    invoke(AgentChannels.invoke.GET_WINDOW_ID),
  setStreamTarget: (input: AgentStreamTargetRequest): Promise<{ ok: boolean }> =>
    invoke(AgentChannels.invoke.SET_STREAM_TARGET, input),
  onEvent: (callback: (event: AgentEvent) => void): (() => void) =>
    subscribe<AgentEvent>(AgentChannels.events.AGENT_EVENT, callback),
  onConversationsChanged: (callback: (payload: { conversationId: string }) => void): (() => void) =>
    subscribe<{ conversationId: string }>(AgentChannels.events.CONVERSATIONS_CHANGED, callback),
  onMessagesChanged: (
    callback: (payload: { conversationId: string; messageId: string }) => void
  ): (() => void) =>
    subscribe<{ conversationId: string; messageId: string }>(
      AgentChannels.events.MESSAGES_CHANGED,
      callback
    )
}
