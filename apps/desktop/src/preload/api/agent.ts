import type {
  AgentEvent,
  ApproveToolRequest,
  BinaryStatus,
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
  createConversation: (input?: { vaultId?: string; backend?: string }): Promise<Conversation> =>
    invoke(AgentChannels.invoke.CREATE_CONVERSATION, input),
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
  getBinaryStatus: (): Promise<BinaryStatus> => invoke(AgentChannels.invoke.GET_BINARY_STATUS),
  acceptDisclosure: (): Promise<{ accepted: boolean }> =>
    invoke(AgentChannels.invoke.ACCEPT_DISCLOSURE),
  getDisclosureState: (): Promise<{ accepted: boolean }> =>
    invoke(AgentChannels.invoke.GET_DISCLOSURE_STATE),
  getWindowId: (): Promise<{ windowId: string | null }> =>
    invoke(AgentChannels.invoke.GET_WINDOW_ID),
  onEvent: (callback: (event: AgentEvent) => void): (() => void) =>
    subscribe<AgentEvent>(AgentChannels.events.AGENT_EVENT, callback)
}
