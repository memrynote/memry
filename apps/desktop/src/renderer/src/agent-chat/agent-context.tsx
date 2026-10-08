import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef
} from 'react'
import type { ReactNode } from 'react'

import type {
  AgentEvent,
  AgentBackendId,
  AgentBackendOptions,
  AgentTurnPermissions,
  ApproveToolRequest,
  AttachmentInput,
  BackendStatusesResponse,
  Conversation,
  Message,
  SendTurnResponse,
  SendTurnRequest
} from '@memry/contracts/ipc-agent'
import { useT } from '@memry/i18n/renderer'

import { extractErrorMessage } from '@/lib/ipc-error'
import { trackRendererError } from '@/lib/telemetry-diagnostics'
import { registerVaultLeaveFlush } from '@/lib/vault-workspace-lifecycle'

import { invokeWhenAgentReady } from './agent-runtime-ready'
import {
  agentReducer,
  initialAgentState,
  type AgentAction,
  type AgentState,
  type QueuedTurn
} from './agent-context.reducer'

interface DisclosureState {
  accepted: boolean
}

interface AgentClientApi {
  listConversations: (input?: { vaultId?: string }) => Promise<Conversation[]>
  createConversation: (input?: {
    vaultId?: string
    backend?: AgentBackendId
    backendModel?: string | null
  }) => Promise<Conversation>
  loadConversation: (input: { id: string }) => Promise<{
    conversation: Conversation | null
    messages: Message[]
  }>
  sendTurn: (input: SendTurnRequest) => Promise<SendTurnResponse>
  cancelTurn: (input: { conversationId: string }) => Promise<{ ok: boolean }>
  approveTool: (input: ApproveToolRequest) => Promise<{ ok: boolean }>
  editTrustList: (input: {
    conversationId: string
    add?: string[]
    remove?: string[]
  }) => Promise<Conversation | null>
  getBackendStatuses: () => Promise<BackendStatusesResponse>
  getDisclosureState: () => Promise<DisclosureState>
  acceptDisclosure: () => Promise<DisclosureState>
  getWindowId: () => Promise<{ windowId: string | null }>
  /**
   * Reports which conversation this window shows so main can stream deltas only
   * here. Optional for the same reason as the sync listeners below: older
   * preload bundles and the test stubs written against them do not expose it.
   */
  setStreamTarget?: (input: { conversationId: string | null }) => Promise<{ ok: boolean }>
  onEvent: (callback: (event: AgentEvent) => void) => () => void
  /**
   * Fired when a sync pull rewrites a conversation row. Optional because older
   * preload bundles (and the test stubs written against them) do not expose it.
   */
  onConversationsChanged?: (callback: (payload: { conversationId: string }) => void) => () => void
  onMessagesChanged?: (
    callback: (payload: { conversationId: string; messageId: string }) => void
  ) => () => void
}

interface AgentContextValue {
  state: AgentState
  dispatch: React.Dispatch<AgentAction>
  refreshConversations: () => Promise<void>
  createConversation: (input?: {
    backend?: AgentBackendId
    backendModel?: string | null
  }) => Promise<Conversation>
  loadConversation: (id: string, options?: { activate?: boolean }) => Promise<void>
  clearActiveConversation: () => void
  sendTurn: (input: {
    conversationId: string
    sourceWindowId: string
    text: string
    backendOptions: AgentBackendOptions
    permissions?: AgentTurnPermissions
    attachments?: AttachmentInput[]
  }) => Promise<void>
  cancelTurn: (conversationId: string) => Promise<void>
  approveTool: (input: ApproveToolRequest) => Promise<void>
  editTrustList: (input: {
    conversationId: string
    add?: string[]
    remove?: string[]
  }) => Promise<void>
  acceptDisclosure: () => Promise<void>
}

const AgentContext = createContext<AgentContextValue | null>(null)

/**
 * Main broadcasts the end of a turn before it releases the conversation's turn
 * lock (it still cleans up the backend and awaits the title), and Stop clears
 * the renderer flag before the child has exited. A queued message sent at that
 * moment is refused with `turn_in_flight`, so only that refusal is retried
 * until the lock frees.
 */
const QUEUED_SEND_RETRY_MS = 500
const QUEUED_SEND_ATTEMPTS = 60

type AssistantStreamDelta = Extract<
  AgentEvent,
  { kind: 'assistant_text_delta' | 'assistant_reasoning_delta' }
>

/**
 * Folds a delta into the tail of the pending buffer when it continues the same
 * message on the same channel (answer text or reasoning). Backends emit dozens of tiny deltas per second and each one used to
 * dispatch on its own, re-rendering every agent-context consumer per token.
 * Merging only into the *adjacent* entry keeps interleaved messages in their
 * exact arrival order, and the buffer stays at one entry per streamed message
 * even when a hidden window goes a long time without a frame.
 */
function bufferAssistantDelta(pending: AssistantStreamDelta[], event: AssistantStreamDelta): void {
  const last = pending[pending.length - 1]
  if (
    last &&
    last.kind === event.kind &&
    last.conversationId === event.conversationId &&
    last.messageId === event.messageId
  ) {
    pending[pending.length - 1] = { ...last, text: `${last.text}${event.text}` }
    return
  }
  pending.push(event)
}

function getAgentApi(): AgentClientApi {
  return (window.api as typeof window.api & { agent: AgentClientApi }).agent
}

/**
 * `active` gates the bootstrap and the exposed context without changing the
 * tree shape. Callers keep this component mounted at all times and flip the
 * prop instead, because adding or removing a tree level here remounts the whole
 * app below it. While inactive the context stays `null`, so consumers see the
 * same "no agent yet" state they saw when the provider was mounted lazily.
 */
export function AgentProvider({
  active = true,
  children
}: {
  active?: boolean
  children: ReactNode
}): React.JSX.Element {
  const { t } = useT('common')
  const [state, dispatch] = useReducer(agentReducer, initialAgentState)

  // Read by the sync-event subscription below without making it a dependency:
  // resubscribing on every conversation switch would tear down and rebuild the
  // IPC listener for no gain.
  const activeConversationIdRef = useRef(state.activeConversationId)
  activeConversationIdRef.current = state.activeConversationId

  // Streamed text is buffered here and committed once per animation frame. A
  // hidden window gets no frames, so a background window stops re-rendering
  // altogether until the next event that has to be applied immediately.
  const pendingDeltasRef = useRef<AssistantStreamDelta[]>([])
  const deltaFrameRef = useRef<number | null>(null)

  const flushAssistantDeltas = useCallback(() => {
    if (deltaFrameRef.current !== null) {
      cancelAnimationFrame(deltaFrameRef.current)
      deltaFrameRef.current = null
    }
    const pending = pendingDeltasRef.current
    if (pending.length === 0) return
    pendingDeltasRef.current = []
    for (const event of pending) dispatch({ type: 'event', event })
  }, [])

  const refreshConversations = useCallback(async () => {
    try {
      const conversations = await getAgentApi().listConversations()
      dispatch({ type: 'set_conversations', conversations })
    } catch (error) {
      trackRendererError('agent_list_conversations', error)
      dispatch({
        type: 'set_error',
        error: extractErrorMessage(error, t('agentChat.errors.loadConversations'))
      })
    }
  }, [t])

  const loadConversation = useCallback(
    async (id: string, options?: { activate?: boolean }) => {
      try {
        const { conversation, messages } = await getAgentApi().loadConversation({ id })
        dispatch({
          type:
            options?.activate === false ? 'set_conversation_messages' : 'set_active_conversation',
          conversation,
          messages
        })
      } catch (error) {
        trackRendererError('agent_load_conversation', error)
        dispatch({
          type: 'set_error',
          error: extractErrorMessage(error, t('agentChat.errors.loadConversation'))
        })
      }
    },
    [t]
  )

  const clearActiveConversation = useCallback(() => {
    dispatch({ type: 'clear_active_conversation' })
  }, [])

  const createConversation = useCallback(
    async (input?: { backend?: AgentBackendId; backendModel?: string | null }) => {
      try {
        const conversation = await getAgentApi().createConversation(input)
        dispatch({ type: 'set_active_conversation', conversation, messages: [] })
        return conversation
      } catch (error) {
        trackRendererError('agent_create_conversation', error)
        const message = extractErrorMessage(error, t('agentChat.errors.createConversation'))
        dispatch({ type: 'set_error', error: message })
        throw new Error(message)
      }
    },
    [t]
  )

  const sendTurn = useCallback(
    async (input: {
      conversationId: string
      sourceWindowId: string
      text: string
      backendOptions: AgentBackendOptions
      permissions?: AgentTurnPermissions
      attachments?: AttachmentInput[]
    }) => {
      dispatch({ type: 'set_in_flight', conversationId: input.conversationId, inFlight: true })
      dispatch({ type: 'set_error', error: null })

      try {
        const result = await getAgentApi().sendTurn({
          conversationId: input.conversationId,
          sourceWindowId: input.sourceWindowId,
          text: input.text,
          backendOptions: input.backendOptions,
          permissions: input.permissions,
          attachments: input.attachments ?? []
        })
        if (!result.ok) {
          const message = result.error ?? t('agentChat.errors.busy')
          throw new Error(message)
        }
      } catch (error) {
        trackRendererError('agent_send_turn', error)
        dispatch({ type: 'set_in_flight', conversationId: input.conversationId, inFlight: false })
        const message = extractErrorMessage(error, t('agentChat.errors.sendTurn'))
        dispatch({ type: 'set_error', error: message })
        throw new Error(message)
      }
    },
    [t]
  )

  const requestCancel = useCallback(
    async (conversationId: string): Promise<boolean> => {
      try {
        await getAgentApi().cancelTurn({ conversationId })
        return true
      } catch (error) {
        trackRendererError('agent_cancel_turn', error)
        dispatch({
          type: 'set_error',
          error: extractErrorMessage(error, t('agentChat.errors.cancelTurn'))
        })
        return false
      }
    },
    [t]
  )

  // The latest queued send each conversation handed to main. Stop flags the
  // attempt that was current when it was pressed, so a late answer to a stopped
  // attempt is always cancelled, and an attempt that starts while main answers
  // the Stop (the stopped turn ended meanwhile) is never touched by it.
  const queuedSendAttemptsRef = useRef(new Map<string, { stopped: boolean }>())

  const cancelTurn = useCallback(
    async (conversationId: string) => {
      const attempt = queuedSendAttemptsRef.current.get(conversationId)
      if (!(await requestCancel(conversationId))) return
      if (attempt) attempt.stopped = true
      if (queuedSendAttemptsRef.current.get(conversationId) === attempt) {
        dispatch({ type: 'set_in_flight', conversationId, inFlight: false })
      }
    },
    [requestCancel]
  )

  const sendQueuedTurn = useCallback(
    async (turn: QueuedTurn, attempt: { stopped: boolean }) => {
      for (let tries = 1; ; tries += 1) {
        let result: SendTurnResponse
        try {
          result = await getAgentApi().sendTurn({
            conversationId: turn.conversationId,
            sourceWindowId: turn.sourceWindowId,
            text: turn.text,
            backendOptions: turn.backendOptions,
            permissions: turn.permissions,
            attachments: turn.attachments
          })
        } catch (error) {
          trackRendererError('agent_send_queued_turn', error)
          dispatch({
            type: 'settle_queued_turn',
            conversationId: turn.conversationId,
            id: turn.id,
            sent: false,
            error: extractErrorMessage(error, t('agentChat.errors.sendTurn'))
          })
          return
        }
        if (result.ok) {
          const stopped = attempt.stopped && (await requestCancel(turn.conversationId))
          dispatch({
            type: 'settle_queued_turn',
            conversationId: turn.conversationId,
            id: turn.id,
            sent: true,
            turnId: result.turnId,
            stopped
          })
          return
        }
        if (result.reason !== 'turn_in_flight' || tries >= QUEUED_SEND_ATTEMPTS) {
          dispatch({
            type: 'settle_queued_turn',
            conversationId: turn.conversationId,
            id: turn.id,
            sent: false,
            error: result.error ?? t('agentChat.errors.busy')
          })
          return
        }
        await new Promise((resolve) => setTimeout(resolve, QUEUED_SEND_RETRY_MS))
        if (attempt.stopped) {
          dispatch({
            type: 'settle_queued_turn',
            conversationId: turn.conversationId,
            id: turn.id,
            sent: false,
            error: null
          })
          return
        }
      }
    },
    [t, requestCancel]
  )

  // One drain for the whole window, so a queue keeps going out after its
  // conversation is no longer on screen. Each message is its own turn.
  useEffect(() => {
    for (const [conversationId, queue] of Object.entries(state.queuedTurns)) {
      const head = queue[0]
      if (
        !head ||
        head.status !== 'queued' ||
        head.editing ||
        state.inFlight[conversationId] === true
      ) {
        continue
      }
      dispatch({ type: 'start_queued_turn', conversationId, id: head.id })
      const attempt = { stopped: false }
      queuedSendAttemptsRef.current.set(conversationId, attempt)
      void sendQueuedTurn(head, attempt)
    }
  }, [state.queuedTurns, state.inFlight, sendQueuedTurn])

  // Leaving the vault shuts down its agent runtime, and this workspace stays
  // mounted, hidden, for a switch back. Nothing queued here may go out against
  // the next vault or fire unasked on return, so it waits for the user to resend.
  useEffect(
    () =>
      registerVaultLeaveFlush(() => {
        for (const attempt of queuedSendAttemptsRef.current.values()) attempt.stopped = true
        dispatch({ type: 'hold_queued_turns' })
      }),
    []
  )

  const approveTool = useCallback(
    async (input: ApproveToolRequest) => {
      try {
        await getAgentApi().approveTool(input)
        dispatch({
          type: 'clear_pending',
          conversationId: input.conversationId,
          toolCallId: input.toolCallId,
          status: input.decision.kind === 'deny' ? 'denied' : 'approved'
        })
      } catch (error) {
        trackRendererError('agent_approve_tool', error)
        dispatch({
          type: 'set_error',
          error: extractErrorMessage(error, t('agentChat.errors.submitApproval'))
        })
      }
    },
    [t]
  )

  const editTrustList = useCallback(
    async (input: { conversationId: string; add?: string[]; remove?: string[] }) => {
      try {
        const conversation = await getAgentApi().editTrustList(input)
        if (conversation) {
          dispatch({
            type: 'set_active_conversation',
            conversation,
            messages: state.messagesByConversation[conversation.id] ?? []
          })
        }
      } catch (error) {
        trackRendererError('agent_edit_trust_list', error)
        dispatch({
          type: 'set_error',
          error: extractErrorMessage(error, t('agentChat.errors.updateTrust'))
        })
      }
    },
    [state.messagesByConversation, t]
  )

  const acceptDisclosure = useCallback(async () => {
    try {
      const result = await getAgentApi().acceptDisclosure()
      dispatch({ type: 'set_disclosure', accepted: result.accepted })
    } catch (error) {
      trackRendererError('agent_accept_disclosure', error)
      dispatch({
        type: 'set_error',
        error: extractErrorMessage(error, t('agentChat.errors.saveDisclosure'))
      })
    }
  }, [t])

  useEffect(() => {
    if (!active) return

    const api = getAgentApi()
    let cancelled = false

    void invokeWhenAgentReady(() => api.getWindowId())
      .then((result) => {
        if (!cancelled) {
          dispatch({ type: 'set_source_window_id', sourceWindowId: result.windowId })
        }
      })
      .catch((error) => {
        if (cancelled) return
        trackRendererError('agent_resolve_window', error)
        dispatch({
          type: 'set_error',
          error: extractErrorMessage(error, t('agentChat.errors.resolveWindow'))
        })
      })

    void invokeWhenAgentReady(() => api.getBackendStatuses())
      .then((statuses) => {
        if (!cancelled) dispatch({ type: 'set_backend_statuses', statuses })
      })
      .catch((error) => {
        if (cancelled) return
        trackRendererError('agent_backend_status', error)
        dispatch({
          type: 'set_error',
          error: extractErrorMessage(error, t('agentChat.errors.detectCli'))
        })
      })

    void invokeWhenAgentReady(() => api.getDisclosureState())
      .then((result) => {
        if (!cancelled) dispatch({ type: 'set_disclosure', accepted: result.accepted })
      })
      .catch((error) => {
        if (cancelled) return
        trackRendererError('agent_load_disclosure', error)
        dispatch({
          type: 'set_error',
          error: extractErrorMessage(error, t('agentChat.errors.loadDisclosure'))
        })
      })

    void invokeWhenAgentReady(() => api.listConversations())
      .then((conversations) => {
        if (!cancelled) dispatch({ type: 'set_conversations', conversations })
      })
      .catch((error) => {
        if (cancelled) return
        trackRendererError('agent_list_conversations', error)
        dispatch({
          type: 'set_error',
          error: extractErrorMessage(error, t('agentChat.errors.loadConversations'))
        })
      })

    const unsubscribe = api.onEvent((event) => {
      if (event.kind === 'assistant_text_delta' || event.kind === 'assistant_reasoning_delta') {
        bufferAssistantDelta(pendingDeltasRef.current, event)
        if (deltaFrameRef.current === null) {
          deltaFrameRef.current = requestAnimationFrame(() => {
            deltaFrameRef.current = null
            flushAssistantDeltas()
          })
        }
        return
      }
      // Every other event has to observe the text that arrived before it, so
      // drain the buffer first and keep the transcript in exact arrival order.
      flushAssistantDeltas()
      dispatch({ type: 'event', event })
    })

    // `agent:event` only carries this window's own turn lifecycle. A
    // conversation or message pulled from another device lands straight in the
    // local DB, so without these the list stays stale until the app restarts.
    const unsubscribeConversations = api.onConversationsChanged?.(() => {
      void refreshConversations()
    })
    const unsubscribeMessages = api.onMessagesChanged?.(({ conversationId }) => {
      if (conversationId !== activeConversationIdRef.current) return
      void loadConversation(conversationId, { activate: false })
    })

    return () => {
      cancelled = true
      // Locale changes re-run this effect mid-stream; commit what is buffered
      // rather than dropping it.
      flushAssistantDeltas()
      unsubscribe()
      unsubscribeConversations?.()
      unsubscribeMessages?.()
    }
  }, [t, active, refreshConversations, loadConversation, flushAssistantDeltas])

  // Main emits one `assistant_text_delta` per token, and a window that does not
  // show the conversation runs the whole reducer for text it never renders.
  // Telling main what this window shows lets it address those deltas; a window
  // that never gets here stays unknown to main and keeps receiving all of them,
  // so a failure degrades to the old fan-out rather than to a stalled
  // transcript.
  useEffect(() => {
    const setStreamTarget = getAgentApi().setStreamTarget
    if (!setStreamTarget) return

    const conversationId = active ? state.activeConversationId : null
    let cancelled = false

    void invokeWhenAgentReady(() =>
      // A retry that outlives its effect must not overwrite a newer target: the
      // bootstrap loop retries for seconds, and conversation switches are fast.
      cancelled ? Promise.resolve({ ok: false }) : setStreamTarget({ conversationId })
    ).catch((error) => {
      if (cancelled) return
      trackRendererError('agent_set_stream_target', error)
    })

    return () => {
      cancelled = true
    }
  }, [active, state.activeConversationId])

  const value = useMemo<AgentContextValue>(
    () => ({
      state,
      dispatch,
      refreshConversations,
      createConversation,
      loadConversation,
      clearActiveConversation,
      sendTurn,
      cancelTurn,
      approveTool,
      editTrustList,
      acceptDisclosure
    }),
    [
      state,
      refreshConversations,
      createConversation,
      loadConversation,
      clearActiveConversation,
      sendTurn,
      cancelTurn,
      approveTool,
      editTrustList,
      acceptDisclosure
    ]
  )

  return <AgentContext.Provider value={active ? value : null}>{children}</AgentContext.Provider>
}

export function useAgent(): AgentContextValue {
  const context = useContext(AgentContext)
  if (!context) throw new Error('useAgent must be used within AgentProvider')
  return context
}

export function useAgentOptional(): AgentContextValue | null {
  return useContext(AgentContext)
}
