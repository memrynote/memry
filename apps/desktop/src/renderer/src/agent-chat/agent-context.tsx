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
import {
  agentReducer,
  initialAgentState,
  type AgentAction,
  type AgentState
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
const AGENT_BOOTSTRAP_ATTEMPTS = 40
const AGENT_BOOTSTRAP_RETRY_MS = 250

/**
 * Mirrors `AGENT_RUNTIME_STARTING_CODE` in main/ipc/agent-lazy-handlers.ts —
 * the two processes cannot share a module, so keep the literals in sync. The
 * lazy agent handlers reject with this code while the runtime boots; it is a
 * stable i18n key, never display text, so the retry match below survives
 * translation.
 */
const AGENT_RUNTIME_STARTING_CODE = 'errors:agent.runtimeStarting'

function getAgentApi(): AgentClientApi {
  return (window.api as typeof window.api & { agent: AgentClientApi }).agent
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Matches the *raw* rejection message, not `extractErrorMessage()`: that helper
 * translates an `errors:` key into the user's language, which would erase the
 * code this predicate keys on and strand the panel in every non-English locale.
 * 'No handler registered' is Electron's own English text for an invoke that
 * arrives before `ipcMain.handle` runs — not ours to localize.
 */
function shouldRetryAgentBootstrap(error: unknown): boolean {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  return raw.includes('No handler registered') || raw.includes(AGENT_RUNTIME_STARTING_CODE)
}

async function invokeWhenAgentReady<T>(fn: () => Promise<T>): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < AGENT_BOOTSTRAP_ATTEMPTS; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error
      if (!shouldRetryAgentBootstrap(error)) break
      await sleep(AGENT_BOOTSTRAP_RETRY_MS)
    }
  }
  throw lastError
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

  const cancelTurn = useCallback(
    async (conversationId: string) => {
      try {
        await getAgentApi().cancelTurn({ conversationId })
        dispatch({ type: 'set_in_flight', conversationId, inFlight: false })
      } catch (error) {
        trackRendererError('agent_cancel_turn', error)
        dispatch({
          type: 'set_error',
          error: extractErrorMessage(error, t('agentChat.errors.cancelTurn'))
        })
      }
    },
    [t]
  )

  const approveTool = useCallback(
    async (input: ApproveToolRequest) => {
      try {
        await getAgentApi().approveTool(input)
        dispatch({
          type: 'clear_pending',
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

    const unsubscribe = api.onEvent((event) => dispatch({ type: 'event', event }))

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
      unsubscribe()
      unsubscribeConversations?.()
      unsubscribeMessages?.()
    }
  }, [t, active, refreshConversations, loadConversation])

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
