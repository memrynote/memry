import { createContext, useCallback, useContext, useEffect, useMemo, useReducer } from 'react'
import type { ReactNode } from 'react'

import type {
  AgentEvent,
  ApproveToolRequest,
  AttachmentInput,
  BinaryStatus,
  SendTurnResponse,
  SendTurnRequest
} from '@memry/contracts/ipc-agent'
import type { Conversation, Message } from '@main/agent/storage/types'

import { extractErrorMessage } from '@/lib/ipc-error'
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
  createConversation: (input?: { vaultId?: string; backend?: string }) => Promise<Conversation>
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
  getBinaryStatus: () => Promise<BinaryStatus>
  getDisclosureState: () => Promise<DisclosureState>
  acceptDisclosure: () => Promise<DisclosureState>
  getWindowId: () => Promise<{ windowId: string | null }>
  onEvent: (callback: (event: AgentEvent) => void) => () => void
}

interface AgentContextValue {
  state: AgentState
  dispatch: React.Dispatch<AgentAction>
  refreshConversations: () => Promise<void>
  createConversation: () => Promise<Conversation>
  loadConversation: (id: string) => Promise<void>
  sendTurn: (input: {
    conversationId: string
    sourceWindowId: string
    text: string
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

function getAgentApi(): AgentClientApi {
  return (window.api as typeof window.api & { agent: AgentClientApi }).agent
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function shouldRetryAgentBootstrap(error: unknown): boolean {
  return extractErrorMessage(error, '').includes('No handler registered')
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

export function AgentProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [state, dispatch] = useReducer(agentReducer, initialAgentState)

  const refreshConversations = useCallback(async () => {
    try {
      const conversations = await getAgentApi().listConversations()
      dispatch({ type: 'set_conversations', conversations })
    } catch (error) {
      dispatch({
        type: 'set_error',
        error: extractErrorMessage(error, 'Could not load agent conversations')
      })
    }
  }, [])

  const loadConversation = useCallback(async (id: string) => {
    try {
      const { conversation, messages } = await getAgentApi().loadConversation({ id })
      dispatch({ type: 'set_active_conversation', conversation, messages })
    } catch (error) {
      dispatch({
        type: 'set_error',
        error: extractErrorMessage(error, 'Could not load agent conversation')
      })
    }
  }, [])

  const createConversation = useCallback(async () => {
    try {
      const conversation = await getAgentApi().createConversation()
      dispatch({ type: 'set_active_conversation', conversation, messages: [] })
      return conversation
    } catch (error) {
      const message = extractErrorMessage(error, 'Could not create agent conversation')
      dispatch({ type: 'set_error', error: message })
      throw new Error(message)
    }
  }, [])

  const sendTurn = useCallback(
    async (input: {
      conversationId: string
      sourceWindowId: string
      text: string
      attachments?: AttachmentInput[]
    }) => {
      dispatch({ type: 'set_in_flight', conversationId: input.conversationId, inFlight: true })
      dispatch({ type: 'set_error', error: null })

      try {
        const result = await getAgentApi().sendTurn({
          conversationId: input.conversationId,
          sourceWindowId: input.sourceWindowId,
          text: input.text,
          attachments: input.attachments ?? []
        })
        if (!result.ok) {
          const message =
            result.error ??
            'Another window is mid-turn for this conversation. Wait for it to finish or stop it from there.'
          throw new Error(message)
        }
      } catch (error) {
        dispatch({ type: 'set_in_flight', conversationId: input.conversationId, inFlight: false })
        const message = extractErrorMessage(error, 'Could not send agent turn')
        dispatch({ type: 'set_error', error: message })
        throw new Error(message)
      }
    },
    []
  )

  const cancelTurn = useCallback(async (conversationId: string) => {
    try {
      await getAgentApi().cancelTurn({ conversationId })
      dispatch({ type: 'set_in_flight', conversationId, inFlight: false })
    } catch (error) {
      dispatch({
        type: 'set_error',
        error: extractErrorMessage(error, 'Could not cancel agent turn')
      })
    }
  }, [])

  const approveTool = useCallback(async (input: ApproveToolRequest) => {
    try {
      await getAgentApi().approveTool(input)
      dispatch({ type: 'clear_pending', toolCallId: input.toolCallId })
    } catch (error) {
      dispatch({
        type: 'set_error',
        error: extractErrorMessage(error, 'Could not submit tool approval')
      })
    }
  }, [])

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
        dispatch({
          type: 'set_error',
          error: extractErrorMessage(error, 'Could not update trusted tools')
        })
      }
    },
    [state.messagesByConversation]
  )

  const acceptDisclosure = useCallback(async () => {
    try {
      const result = await getAgentApi().acceptDisclosure()
      dispatch({ type: 'set_disclosure', accepted: result.accepted })
    } catch (error) {
      dispatch({
        type: 'set_error',
        error: extractErrorMessage(error, 'Could not save disclosure state')
      })
    }
  }, [])

  useEffect(() => {
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
        dispatch({
          type: 'set_error',
          error: extractErrorMessage(error, 'Could not resolve agent source window')
        })
      })

    void invokeWhenAgentReady(() => api.getBinaryStatus())
      .then((status) => {
        if (!cancelled) dispatch({ type: 'set_binary_status', status })
      })
      .catch((error) => {
        if (cancelled) return
        dispatch({
          type: 'set_error',
          error: extractErrorMessage(error, 'Could not detect Claude CLI')
        })
      })

    void invokeWhenAgentReady(() => api.getDisclosureState())
      .then((result) => {
        if (!cancelled) dispatch({ type: 'set_disclosure', accepted: result.accepted })
      })
      .catch((error) => {
        if (cancelled) return
        dispatch({
          type: 'set_error',
          error: extractErrorMessage(error, 'Could not load disclosure state')
        })
      })

    void invokeWhenAgentReady(() => api.listConversations())
      .then((conversations) => {
        if (!cancelled) dispatch({ type: 'set_conversations', conversations })
      })
      .catch((error) => {
        if (cancelled) return
        dispatch({
          type: 'set_error',
          error: extractErrorMessage(error, 'Could not load agent conversations')
        })
      })

    const unsubscribe = api.onEvent((event) => dispatch({ type: 'event', event }))
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  const value = useMemo<AgentContextValue>(
    () => ({
      state,
      dispatch,
      refreshConversations,
      createConversation,
      loadConversation,
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
      sendTurn,
      cancelTurn,
      approveTool,
      editTrustList,
      acceptDisclosure
    ]
  )

  return <AgentContext.Provider value={value}>{children}</AgentContext.Provider>
}

export function useAgent(): AgentContextValue {
  const context = useContext(AgentContext)
  if (!context) throw new Error('useAgent must be used within AgentProvider')
  return context
}

export function useAgentOptional(): AgentContextValue | null {
  return useContext(AgentContext)
}
