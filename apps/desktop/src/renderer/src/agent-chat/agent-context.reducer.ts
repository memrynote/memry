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
  /**
   * Conversation ids whose transcript was hydrated from main, least recently
   * hydrated first. Drives transcript eviction; see
   * {@link HYDRATED_CONVERSATION_LIMIT}.
   */
  hydratedConversationIds: string[]
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
  | {
      type: 'clear_pending'
      conversationId: string
      toolCallId: string
      status?: 'approved' | 'denied'
    }

/**
 * How many conversation transcripts stay hydrated in renderer memory. Without a
 * cap, a day of Agent Chat use retains every opened conversation's full message
 * array — including every tool call's args and every tool result's output — for
 * the lifetime of the window.
 *
 * The cap sits above the number of agent surfaces that can be mounted at once
 * (four split-view panes plus the right sidebar) so a transcript is never
 * evicted out from under a view that is rendering it, which would make that
 * view re-fetch it immediately.
 */
export const HYDRATED_CONVERSATION_LIMIT = 6

export const initialAgentState: AgentState = {
  backendStatuses: null,
  disclosureAccepted: null,
  sourceWindowId: null,
  activeConversationId: null,
  conversations: {},
  messagesByConversation: {},
  hydratedConversationIds: [],
  pendingApprovals: [],
  inFlight: {},
  hasStreamingMessage: false,
  error: null
}

/**
 * Transcripts already known to be ordered by `createdAt`. Every array this
 * reducer produces preserves that order, so once one is marked the next upsert
 * can splice a message into place instead of re-sorting and re-copying the
 * whole transcript on every streamed event. Arrays handed over by main are not
 * marked, so the first upsert on one still pays for a sort — and marks its
 * result. Keyed by array identity, so entries disappear with the transcript.
 */
const orderedTranscripts = new WeakSet<Message[]>()

function markOrdered(messages: Message[]): Message[] {
  orderedTranscripts.add(messages)
  return messages
}

/** Positional copies (`slice`/`map`) keep `createdAt` order, so they inherit the mark. */
function carryOrder(source: Message[], next: Message[]): Message[] {
  return orderedTranscripts.has(source) ? markOrdered(next) : next
}

/** First index whose `createdAt` is greater than `createdAt`. Assumes an ordered array. */
function upperBound(messages: Message[], createdAt: number): number {
  let low = 0
  let high = messages.length
  while (low < high) {
    const mid = (low + high) >>> 1
    if (messages[mid].createdAt <= createdAt) low = mid + 1
    else high = mid
  }
  return low
}

/** The original merge-then-sort, kept for transcripts whose order we cannot vouch for. */
function sortMerged(messages: Message[], existing: number, nextMessage: Message): Message[] {
  const merged =
    existing === -1
      ? [...messages, nextMessage]
      : messages.map((message, index) => (index === existing ? nextMessage : message))
  return markOrdered(merged.sort((left, right) => left.createdAt - right.createdAt))
}

function appendAssistantDelta(messages: Message[], event: AgentEvent): Message[] {
  if (event.kind !== 'assistant_text_delta') return messages

  const index = messages.findIndex(
    (message) => message.id === event.messageId && message.content.role === 'assistant'
  )
  // The delta can arrive before the message it belongs to (or for a transcript
  // this window never loaded). Returning the same reference keeps the array
  // identity stable so the stream does not re-render for nothing.
  if (index === -1) return messages

  const target = messages[index]
  if (target.content.role !== 'assistant') return messages

  const next = messages.slice()
  next[index] = {
    ...target,
    content: {
      role: 'assistant',
      data: {
        text: `${target.content.data.text}${event.text}`
      }
    }
  }
  return carryOrder(messages, next)
}

function upsertMessage(messages: Message[], nextMessage: Message): Message[] {
  const existing = messages.findIndex((message) => message.id === nextMessage.id)
  // Unknown order, or a re-sent message whose timestamp moved: only a full sort
  // can place it, so fall back to the original behaviour.
  if (!orderedTranscripts.has(messages)) return sortMerged(messages, existing, nextMessage)
  if (existing === -1) {
    // A stable sort keeps an appended message last among equal timestamps, which
    // is exactly the upper bound of its `createdAt` in an ordered transcript.
    const next = messages.slice()
    next.splice(upperBound(messages, nextMessage.createdAt), 0, nextMessage)
    return markOrdered(next)
  }
  if (messages[existing].createdAt !== nextMessage.createdAt) {
    return sortMerged(messages, existing, nextMessage)
  }
  // Same timestamp: a stable sort cannot move it past its equal-timestamp
  // neighbours, so replacing in place is the same array the sort would produce.
  const next = messages.slice()
  next[existing] = nextMessage
  return markOrdered(next)
}

/** Newest `createdAt` in the transcript; O(1) once the transcript order is known. */
function newestCreatedAt(messages: Message[]): number {
  if (!orderedTranscripts.has(messages)) {
    return messages.reduce((max, message) => Math.max(max, message.createdAt), 0)
  }
  return Math.max(0, messages[messages.length - 1]?.createdAt ?? 0)
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
  const newest = newestCreatedAt(messages)
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
  let matched = false
  const next: Message[] = messages.map((message) => {
    if (message.toolCallId !== toolCallId || message.content.role !== 'tool_call') return message
    matched = true
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
  return matched ? carryOrder(messages, next) : messages
}

function updateToolCallStatusIn(
  messagesByConversation: AgentState['messagesByConversation'],
  conversationId: string,
  toolCallId: string,
  status: ToolCallStatus,
  patch?: { output?: unknown; error?: { code: string; message: string } }
): AgentState['messagesByConversation'] {
  const messages = messagesByConversation[conversationId]
  // Transcript not loaded (or already evicted): nothing to patch here. The persisted
  // transcript is reloaded from the main process on open, so no result is lost.
  if (!messages) return messagesByConversation
  const nextMessages = updateToolCallStatus(messages, toolCallId, status, patch)
  if (nextMessages === messages) return messagesByConversation
  return { ...messagesByConversation, [conversationId]: nextMessages }
}

/**
 * A transcript may only be dropped when main can rebuild it byte for byte.
 * Anything still live in this window — the conversation on screen, a turn we
 * started, an approval the user has not answered, or an assistant message whose
 * streamed text main only persists once the turn ends — is retained regardless
 * of the cap.
 */
function isPinnedTranscript(
  state: AgentState,
  input: {
    activeConversationId: string | null
    messagesByConversation: AgentState['messagesByConversation']
    conversationId: string
  }
): boolean {
  if (input.conversationId === input.activeConversationId) return true
  if (state.inFlight[input.conversationId] === true) return true
  if (state.pendingApprovals.some((pending) => pending.conversationId === input.conversationId)) {
    return true
  }
  return (input.messagesByConversation[input.conversationId] ?? []).some(
    (message) => message.status === 'streaming'
  )
}

/**
 * Records `hydratedConversationId` as the most recently hydrated transcript and
 * drops the transcripts that fall outside the cap. Everything dropped here is
 * re-fetched from main the next time the conversation is opened.
 */
function retainHydratedTranscripts(
  state: AgentState,
  input: {
    hydratedConversationId: string
    activeConversationId: string | null
    messagesByConversation: AgentState['messagesByConversation']
  }
): Pick<AgentState, 'messagesByConversation' | 'hydratedConversationIds'> {
  const hydratedConversationIds = [
    ...state.hydratedConversationIds.filter((id) => id !== input.hydratedConversationId),
    input.hydratedConversationId
  ]
  const recent = new Set(hydratedConversationIds.slice(-HYDRATED_CONVERSATION_LIMIT))
  const evicted = new Set(
    Object.keys(input.messagesByConversation).filter(
      (conversationId) =>
        !recent.has(conversationId) &&
        !isPinnedTranscript(state, {
          activeConversationId: input.activeConversationId,
          messagesByConversation: input.messagesByConversation,
          conversationId
        })
    )
  )
  if (evicted.size === 0) {
    return { messagesByConversation: input.messagesByConversation, hydratedConversationIds }
  }
  return {
    messagesByConversation: Object.fromEntries(
      Object.entries(input.messagesByConversation).filter(([id]) => !evicted.has(id))
    ),
    hydratedConversationIds: hydratedConversationIds.filter((id) => !evicted.has(id))
  }
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
    case 'set_active_conversation': {
      if (!action.conversation) {
        return { ...state, activeConversationId: null }
      }
      const conversationId = action.conversation.id
      return {
        ...state,
        activeConversationId: conversationId,
        conversations: {
          ...state.conversations,
          [conversationId]: action.conversation
        },
        ...retainHydratedTranscripts(state, {
          hydratedConversationId: conversationId,
          activeConversationId: conversationId,
          messagesByConversation: {
            ...state.messagesByConversation,
            [conversationId]: action.messages
          }
        })
      }
    }
    case 'set_conversation_messages': {
      if (!action.conversation) return state
      const conversationId = action.conversation.id
      return {
        ...state,
        conversations: {
          ...state.conversations,
          [conversationId]: action.conversation
        },
        ...retainHydratedTranscripts(state, {
          hydratedConversationId: conversationId,
          activeConversationId: state.activeConversationId,
          messagesByConversation: {
            ...state.messagesByConversation,
            [conversationId]: action.messages
          }
        })
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
          ? updateToolCallStatusIn(
              state.messagesByConversation,
              action.conversationId,
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
        const current = state.messagesByConversation[event.conversationId] ?? []
        const next = appendAssistantDelta(current, event)
        if (next === current) return state
        return {
          ...state,
          messagesByConversation: {
            ...state.messagesByConversation,
            [event.conversationId]: next
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
          messagesByConversation: updateToolCallStatusIn(
            state.messagesByConversation,
            event.conversationId,
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
