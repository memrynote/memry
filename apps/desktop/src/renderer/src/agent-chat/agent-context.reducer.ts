import type {
  AgentEvent,
  BackendStatusesResponse,
  Conversation,
  Message,
  ToolCallStatus
} from '@memry/contracts/ipc-agent'

export type PendingToolApproval = Extract<AgentEvent, { kind: 'tool_call_pending_approval' }>

export interface AgentState {
  backendStatuses: BackendStatusesResponse | null
  disclosureAccepted: boolean | null
  sourceWindowId: string | null
  activeConversationId: string | null
  conversations: Record<string, Conversation>
  messagesByConversation: Record<string, Message[]>
  pendingApprovals: PendingToolApproval[]
  inFlight: Record<string, boolean>
  /** Derived: any message in any conversation is still streaming. Kept here so
   * subscribers read a scalar instead of rescanning every transcript. */
  hasStreamingMessage: boolean
  error: string | null
}

export type AgentAction =
  | { type: 'set_backend_statuses'; statuses: BackendStatusesResponse }
  | { type: 'set_disclosure'; accepted: boolean }
  | { type: 'set_source_window_id'; sourceWindowId: string | null }
  | { type: 'set_conversations'; conversations: Conversation[] }
  | {
      type: 'set_active_conversation'
      conversation: Conversation | null
      messages: Message[]
    }
  | {
      type: 'set_conversation_messages'
      conversation: Conversation | null
      messages: Message[]
    }
  | { type: 'clear_active_conversation' }
  | { type: 'set_in_flight'; conversationId: string; inFlight: boolean }
  | { type: 'set_error'; error: string | null }
  | { type: 'event'; event: AgentEvent }
  | { type: 'clear_pending'; toolCallId: string; status?: 'approved' | 'denied' }

export const initialAgentState: AgentState = {
  backendStatuses: null,
  disclosureAccepted: null,
  sourceWindowId: null,
  activeConversationId: null,
  conversations: {},
  messagesByConversation: {},
  pendingApprovals: [],
  inFlight: {},
  hasStreamingMessage: false,
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

function upsertMessage(messages: Message[], nextMessage: Message): Message[] {
  const existing = messages.findIndex((message) => message.id === nextMessage.id)
  const next =
    existing === -1
      ? [...messages, nextMessage]
      : messages.map((message, index) => (index === existing ? nextMessage : message))
  return [...next].sort((left, right) => left.createdAt - right.createdAt)
}

function upsertToolCallMessage(
  messages: Message[],
  input: {
    conversationId: string
    toolCallId: string
    name: string
    args: unknown
    status: ToolCallStatus
  }
): Message[] {
  const newest = messages.reduce((max, message) => Math.max(max, message.createdAt), 0)
  return upsertMessage(messages, {
    id: `tool-call-${input.toolCallId}`,
    conversationId: input.conversationId,
    role: 'tool_call',
    content: {
      role: 'tool_call',
      data: {
        tool: input.name,
        args:
          input.args && typeof input.args === 'object' && !Array.isArray(input.args)
            ? (input.args as Record<string, unknown>)
            : {},
        status: input.status
      }
    },
    toolCallId: input.toolCallId,
    attachments: [],
    status: 'streaming',
    vectorClock: {},
    createdAt: newest + 1,
    updatedAt: newest + 1,
    deletedAt: null
  })
}

function updateToolCallStatus(
  messages: Message[],
  toolCallId: string,
  status: ToolCallStatus,
  patch?: { output?: unknown; error?: { code: string; message: string } }
): Message[] {
  return messages.map((message) => {
    if (message.toolCallId !== toolCallId || message.content.role !== 'tool_call') return message
    return {
      ...message,
      status:
        status === 'completed' || status === 'output-available'
          ? 'completed'
          : status === 'failed' || status === 'output-error' || status === 'output-denied'
            ? 'error'
            : message.status,
      content: {
        role: 'tool_call',
        data: {
          ...message.content.data,
          status,
          ...patch
        }
      }
    }
  })
}

function updateToolCallStatusEverywhere(
  messagesByConversation: AgentState['messagesByConversation'],
  toolCallId: string,
  status: ToolCallStatus,
  patch?: { output?: unknown; error?: { code: string; message: string } }
): AgentState['messagesByConversation'] {
  return Object.fromEntries(
    Object.entries(messagesByConversation).map(([conversationId, messages]) => [
      conversationId,
      updateToolCallStatus(messages, toolCallId, status, patch)
    ])
  )
}

function withoutInFlight(state: AgentState, conversationId: string): Record<string, boolean> {
  const { [conversationId]: _removed, ...rest } = state.inFlight
  return rest
}

function scanForStreamingMessage(
  messagesByConversation: AgentState['messagesByConversation']
): boolean {
  for (const messages of Object.values(messagesByConversation)) {
    for (const message of messages) {
      if (message.status === 'streaming') return true
    }
  }
  return false
}

export function agentReducer(state: AgentState, action: AgentAction): AgentState {
  const next = reduceAgentState(state, action)
  // The transcripts are untouched, so no message status can have changed.
  if (next.messagesByConversation === state.messagesByConversation) return next
  // `assistant_text_delta` only appends text to an existing message: it never adds,
  // removes, or restatuses one, so the derived flag survives every streamed token.
  if (action.type === 'event' && action.event.kind === 'assistant_text_delta') return next
  const hasStreamingMessage = scanForStreamingMessage(next.messagesByConversation)
  if (hasStreamingMessage === next.hasStreamingMessage) return next
  return { ...next, hasStreamingMessage }
}

function reduceAgentState(state: AgentState, action: AgentAction): AgentState {
  switch (action.type) {
    case 'set_backend_statuses':
      return {
        ...state,
        backendStatuses: action.statuses
      }
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
    case 'set_conversation_messages':
      if (!action.conversation) return state
      return {
        ...state,
        conversations: {
          ...state.conversations,
          [action.conversation.id]: action.conversation
        },
        messagesByConversation: {
          ...state.messagesByConversation,
          [action.conversation.id]: action.messages
        }
      }
    case 'clear_active_conversation':
      return {
        ...state,
        activeConversationId: null
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
        ),
        messagesByConversation: action.status
          ? updateToolCallStatusEverywhere(
              state.messagesByConversation,
              action.toolCallId,
              action.status === 'denied' ? 'output-denied' : 'approval-responded'
            )
          : state.messagesByConversation
      }
    case 'event': {
      const event = action.event
      if (event.kind === 'message_upserted') {
        return {
          ...state,
          messagesByConversation: {
            ...state.messagesByConversation,
            [event.message.conversationId]: upsertMessage(
              state.messagesByConversation[event.message.conversationId] ?? [],
              event.message
            )
          }
        }
      }
      if (event.kind === 'conversation_updated') {
        return {
          ...state,
          conversations: {
            ...state.conversations,
            [event.conversation.id]: event.conversation
          }
        }
      }
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
          pendingApprovals: upsertPendingApproval(state.pendingApprovals, event),
          messagesByConversation: {
            ...state.messagesByConversation,
            [event.conversationId]: upsertToolCallMessage(
              state.messagesByConversation[event.conversationId] ?? [],
              {
                conversationId: event.conversationId,
                toolCallId: event.toolCallId,
                name: event.name,
                args: event.args,
                status: 'approval-requested'
              }
            )
          }
        }
      }
      if (event.kind === 'tool_call_started') {
        return {
          ...state,
          messagesByConversation: {
            ...state.messagesByConversation,
            [event.conversationId]: upsertToolCallMessage(
              state.messagesByConversation[event.conversationId] ?? [],
              {
                conversationId: event.conversationId,
                toolCallId: event.toolCallId,
                name: event.name,
                args: event.args,
                status: 'input-available'
              }
            )
          }
        }
      }
      if (event.kind === 'tool_call_completed' || event.kind === 'tool_call_failed') {
        const failedAsDenied =
          event.kind === 'tool_call_failed' && event.error.code === 'PERMISSION_DENIED'
        return {
          ...state,
          pendingApprovals: state.pendingApprovals.filter(
            (pending) => pending.toolCallId !== event.toolCallId
          ),
          messagesByConversation: updateToolCallStatusEverywhere(
            state.messagesByConversation,
            event.toolCallId,
            event.kind === 'tool_call_completed'
              ? 'output-available'
              : failedAsDenied
                ? 'output-denied'
                : 'output-error',
            event.kind === 'tool_call_completed' ? { output: event.result } : { error: event.error }
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
