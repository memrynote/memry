import type { AgentEvent, BinaryStatus, Conversation, Message } from '@memry/contracts/ipc-agent'

export type PendingToolApproval = Extract<AgentEvent, { kind: 'tool_call_pending_approval' }>

export interface AgentState {
  binaryStatus: BinaryStatus | null
  disclosureAccepted: boolean | null
  sourceWindowId: string | null
  activeConversationId: string | null
  conversations: Record<string, Conversation>
  messagesByConversation: Record<string, Message[]>
  pendingApprovals: PendingToolApproval[]
  inFlight: Record<string, boolean>
  error: string | null
}

export type AgentAction =
  | { type: 'set_binary_status'; status: BinaryStatus }
  | { type: 'set_disclosure'; accepted: boolean }
  | { type: 'set_source_window_id'; sourceWindowId: string | null }
  | { type: 'set_conversations'; conversations: Conversation[] }
  | {
      type: 'set_active_conversation'
      conversation: Conversation | null
      messages: Message[]
    }
  | { type: 'set_in_flight'; conversationId: string; inFlight: boolean }
  | { type: 'set_error'; error: string | null }
  | { type: 'event'; event: AgentEvent }
  | { type: 'clear_pending'; toolCallId: string }

export const initialAgentState: AgentState = {
  binaryStatus: null,
  disclosureAccepted: null,
  sourceWindowId: null,
  activeConversationId: null,
  conversations: {},
  messagesByConversation: {},
  pendingApprovals: [],
  inFlight: {},
  error: null
}

function appendAssistantDelta(messages: Message[], event: AgentEvent): Message[] {
  if (event.kind !== 'assistant_text_delta') return messages

  return messages.map((message) => {
    if (message.id !== event.messageId || message.content.role !== 'assistant') return message
    return {
      ...message,
      content: {
        role: 'assistant',
        data: {
          text: `${message.content.data.text}${event.text}`
        }
      }
    }
  })
}

function withoutInFlight(state: AgentState, conversationId: string): Record<string, boolean> {
  const { [conversationId]: _removed, ...rest } = state.inFlight
  return rest
}

export function agentReducer(state: AgentState, action: AgentAction): AgentState {
  switch (action.type) {
    case 'set_binary_status':
      return { ...state, binaryStatus: action.status }
    case 'set_disclosure':
      return { ...state, disclosureAccepted: action.accepted }
    case 'set_source_window_id':
      return { ...state, sourceWindowId: action.sourceWindowId }
    case 'set_conversations':
      return {
        ...state,
        conversations: Object.fromEntries(
          action.conversations.map((conversation) => [conversation.id, conversation])
        )
      }
    case 'set_active_conversation':
      if (!action.conversation) {
        return { ...state, activeConversationId: null }
      }
      return {
        ...state,
        activeConversationId: action.conversation.id,
        conversations: {
          ...state.conversations,
          [action.conversation.id]: action.conversation
        },
        messagesByConversation: {
          ...state.messagesByConversation,
          [action.conversation.id]: action.messages
        }
      }
    case 'set_in_flight':
      return {
        ...state,
        inFlight: action.inFlight
          ? { ...state.inFlight, [action.conversationId]: true }
          : withoutInFlight(state, action.conversationId)
      }
    case 'set_error':
      return { ...state, error: action.error }
    case 'clear_pending':
      return {
        ...state,
        pendingApprovals: state.pendingApprovals.filter(
          (pending) => pending.toolCallId !== action.toolCallId
        )
      }
    case 'event': {
      const event = action.event
      if (event.kind === 'assistant_text_delta') {
        return {
          ...state,
          messagesByConversation: {
            ...state.messagesByConversation,
            [event.conversationId]: appendAssistantDelta(
              state.messagesByConversation[event.conversationId] ?? [],
              event
            )
          }
        }
      }
      if (event.kind === 'tool_call_pending_approval') {
        return {
          ...state,
          pendingApprovals: upsertPendingApproval(state.pendingApprovals, event)
        }
      }
      if (event.kind === 'tool_call_completed' || event.kind === 'tool_call_failed') {
        return {
          ...state,
          pendingApprovals: state.pendingApprovals.filter(
            (pending) => pending.toolCallId !== event.toolCallId
          )
        }
      }
      if (
        event.kind === 'turn_completed' ||
        event.kind === 'turn_cancelled' ||
        event.kind === 'turn_error'
      ) {
        return {
          ...state,
          inFlight: withoutInFlight(state, event.conversationId),
          error: event.kind === 'turn_error' ? event.message : state.error
        }
      }
      return state
    }
    default:
      return state
  }
}

function upsertPendingApproval(
  pendingApprovals: PendingToolApproval[],
  event: PendingToolApproval
): PendingToolApproval[] {
  const existing = pendingApprovals.findIndex((pending) => pending.toolCallId === event.toolCallId)
  if (existing === -1) return [...pendingApprovals, event]
  return pendingApprovals.map((pending, index) => (index === existing ? event : pending))
}
