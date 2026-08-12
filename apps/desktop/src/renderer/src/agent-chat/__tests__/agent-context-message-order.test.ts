import { describe, expect, it } from 'vitest'

import type { AgentEvent, Conversation, Message } from '@memry/contracts/ipc-agent'

import { agentReducer, initialAgentState, type AgentState } from '../agent-context.reducer'

const CONVERSATION_ID = 'conversation-1'

function conversation(id: string): Conversation {
  return {
    id,
    vaultId: 'vault-1',
    title: id,
    backend: 'claude_cli',
    backendModel: null,
    trustList: [],
    pinned: false,
    vectorClock: {},
    fieldClocks: {},
    createdAt: 100,
    updatedAt: 100,
    deletedAt: null,
    lastSyncedAt: null
  }
}

function message(input: { id: string; createdAt: number; text?: string }): Message {
  return {
    id: input.id,
    conversationId: CONVERSATION_ID,
    role: 'assistant',
    content: { role: 'assistant', data: { text: input.text ?? input.id } },
    toolCallId: null,
    attachments: [],
    status: 'completed',
    vectorClock: {},
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    deletedAt: null
  }
}

/**
 * The merge-then-full-sort this reducer used to run on every `message_upserted`.
 * Kept verbatim as the oracle the fast paths must agree with, message for
 * message, for every arrival order.
 */
function legacyUpsert(messages: Message[], nextMessage: Message): Message[] {
  const existing = messages.findIndex((candidate) => candidate.id === nextMessage.id)
  const next =
    existing === -1
      ? [...messages, nextMessage]
      : messages.map((candidate, index) => (index === existing ? nextMessage : candidate))
  return [...next].sort((left, right) => left.createdAt - right.createdAt)
}

function upsertEvent(nextMessage: Message): AgentEvent {
  return { kind: 'message_upserted', message: nextMessage }
}

function hydrated(messages: Message[]): AgentState {
  return agentReducer(initialAgentState, {
    type: 'set_active_conversation',
    conversation: conversation(CONVERSATION_ID),
    messages
  })
}

function transcript(state: AgentState): Message[] {
  return state.messagesByConversation[CONVERSATION_ID] ?? []
}

/** Applies every upsert through both the reducer and the old algorithm. */
function bothOrders(
  initial: Message[],
  upserts: Message[]
): { actual: Message[]; oracle: Message[] } {
  let state = hydrated(initial)
  let oracle = initial
  for (const nextMessage of upserts) {
    state = agentReducer(state, { type: 'event', event: upsertEvent(nextMessage) })
    oracle = legacyUpsert(oracle, nextMessage)
  }
  return { actual: transcript(state), oracle }
}

function ids(messages: Message[]): string[] {
  return messages.map((entry) => entry.id)
}

describe('agent reducer message ordering', () => {
  it('matches the old full sort for shuffled arrivals', () => {
    const arrivals = [
      message({ id: 'e', createdAt: 500 }),
      message({ id: 'b', createdAt: 200 }),
      message({ id: 'd', createdAt: 400 }),
      message({ id: 'a', createdAt: 100 }),
      message({ id: 'c', createdAt: 300 })
    ]
    const { actual, oracle } = bothOrders([], arrivals)
    expect(ids(actual)).toEqual(ids(oracle))
    expect(ids(actual)).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('matches the old full sort for equal timestamps', () => {
    const arrivals = [
      message({ id: 'first', createdAt: 100 }),
      message({ id: 'second', createdAt: 100 }),
      message({ id: 'third', createdAt: 100 }),
      message({ id: 'later', createdAt: 200 }),
      message({ id: 'fourth', createdAt: 100 })
    ]
    const { actual, oracle } = bothOrders([], arrivals)
    expect(ids(actual)).toEqual(ids(oracle))
    // Equal timestamps keep arrival order; the newer one stays last.
    expect(ids(actual)).toEqual(['first', 'second', 'third', 'fourth', 'later'])
  })

  it('matches the old full sort when a message is re-sent unchanged', () => {
    const initial = [
      message({ id: 'a', createdAt: 100 }),
      message({ id: 'b', createdAt: 100 }),
      message({ id: 'c', createdAt: 200 })
    ]
    const { actual, oracle } = bothOrders(initial, [
      message({ id: 'a', createdAt: 100, text: 'edited' })
    ])
    expect(ids(actual)).toEqual(ids(oracle))
    expect(ids(actual)).toEqual(['a', 'b', 'c'])
    expect(actual[0].content).toEqual({ role: 'assistant', data: { text: 'edited' } })
  })

  it('matches the old full sort when a re-sent message moves later', () => {
    const initial = [
      message({ id: 'a', createdAt: 100 }),
      message({ id: 'b', createdAt: 200 }),
      message({ id: 'c', createdAt: 300 })
    ]
    const { actual, oracle } = bothOrders(initial, [message({ id: 'a', createdAt: 250 })])
    expect(ids(actual)).toEqual(ids(oracle))
    expect(ids(actual)).toEqual(['b', 'a', 'c'])
  })

  it('matches the old full sort when a re-sent message moves earlier', () => {
    const initial = [
      message({ id: 'a', createdAt: 100 }),
      message({ id: 'b', createdAt: 200 }),
      message({ id: 'c', createdAt: 300 })
    ]
    const { actual, oracle } = bothOrders(initial, [message({ id: 'c', createdAt: 150 })])
    expect(ids(actual)).toEqual(ids(oracle))
    expect(ids(actual)).toEqual(['a', 'c', 'b'])
  })

  it('matches the old full sort when the hydrated transcript arrives out of order', () => {
    const initial = [
      message({ id: 'late', createdAt: 300 }),
      message({ id: 'early', createdAt: 100 })
    ]
    const { actual, oracle } = bothOrders(initial, [message({ id: 'mid', createdAt: 200 })])
    expect(ids(actual)).toEqual(ids(oracle))
  })

  it('does not re-sort the transcript on every upsert', () => {
    const initial = Array.from({ length: 40 }, (_, index) =>
      message({ id: `seed-${index}`, createdAt: index + 1 })
    )
    let state = hydrated(initial)
    // The first upsert on a transcript from main still sorts; from then on the
    // order is known and appending must not compare anything.
    state = agentReducer(state, {
      type: 'event',
      event: upsertEvent(message({ id: 'warm', createdAt: 41 }))
    })

    let comparisons = 0
    for (const entry of transcript(state)) {
      Object.defineProperty(entry, 'createdAt', {
        configurable: true,
        enumerable: true,
        get() {
          comparisons += 1
          return entry.updatedAt
        }
      })
    }
    state = agentReducer(state, {
      type: 'event',
      event: upsertEvent(message({ id: 'appended', createdAt: 42 }))
    })

    expect(ids(transcript(state)).at(-1)).toBe('appended')
    // A binary search over 41 entries, not the ~41·log2(41) reads a sort costs.
    expect(comparisons).toBeLessThanOrEqual(6)
  })

  it('reads only the newest timestamp when placing a tool call', () => {
    const initial = Array.from({ length: 30 }, (_, index) =>
      message({ id: `seed-${index}`, createdAt: index + 1 })
    )
    let state = hydrated(initial)
    state = agentReducer(state, {
      type: 'event',
      event: upsertEvent(message({ id: 'warm', createdAt: 31 }))
    })

    let reads = 0
    for (const entry of transcript(state)) {
      Object.defineProperty(entry, 'createdAt', {
        configurable: true,
        enumerable: true,
        get() {
          reads += 1
          return entry.updatedAt
        }
      })
    }
    state = agentReducer(state, {
      type: 'event',
      event: {
        kind: 'tool_call_started',
        conversationId: CONVERSATION_ID,
        toolCallId: 'call-1',
        name: 'search_notes',
        args: {}
      }
    })

    const messages = transcript(state)
    expect(messages.at(-1)?.id).toBe('tool-call-call-1')
    expect(messages.at(-1)?.createdAt).toBe(32)
    // The old reduce read `createdAt` on all 31 messages just to find the max.
    expect(reads).toBeLessThanOrEqual(6)
  })

  it('keeps the transcript ordered across streamed deltas and tool results', () => {
    let state = hydrated([message({ id: 'a', createdAt: 100 })])
    state = agentReducer(state, {
      type: 'event',
      event: upsertEvent(message({ id: 'b', createdAt: 200, text: '' }))
    })
    state = agentReducer(state, {
      type: 'event',
      event: {
        kind: 'assistant_text_delta',
        conversationId: CONVERSATION_ID,
        messageId: 'b',
        text: 'hello'
      }
    })
    state = agentReducer(state, {
      type: 'event',
      event: {
        kind: 'tool_call_started',
        conversationId: CONVERSATION_ID,
        toolCallId: 'call-1',
        name: 'search_notes',
        args: {}
      }
    })
    state = agentReducer(state, {
      type: 'event',
      event: {
        kind: 'tool_call_completed',
        conversationId: CONVERSATION_ID,
        toolCallId: 'call-1',
        result: { ok: true }
      }
    })
    state = agentReducer(state, {
      type: 'event',
      event: upsertEvent(message({ id: 'c', createdAt: 300 }))
    })

    expect(ids(transcript(state))).toEqual(['a', 'b', 'tool-call-call-1', 'c'])
  })
})
