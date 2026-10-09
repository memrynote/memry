import { describe, expect, it } from 'vitest'

import type { MessageStore } from '../../storage/message-store'
import type { Message, MessageContent } from '../../storage/types'
import { maybeCompact } from '../compactor'
import { assemblePrompt } from '../prompt-assembler'

function fakeStore(): MessageStore & { all: Message[] } {
  const all: Message[] = []
  return {
    all,
    append(input) {
      const next: Message = {
        id: `m${all.length + 1}`,
        conversationId: input.conversationId,
        role: input.role,
        content: input.content,
        toolCallId: input.toolCallId ?? null,
        attachments: input.attachments,
        status: input.status,
        vectorClock: { d: 1 },
        createdAt: all.length + 1,
        updatedAt: all.length + 1,
        deletedAt: null
      }
      all.push(next)
      return next
    },
    getById: (id) => all.find((item) => item.id === id) ?? null,
    listByConversation: () => [...all],
    updateStreaming: () => {
      throw new Error('unused')
    },
    markTerminal: () => {
      throw new Error('unused')
    }
  }
}

function addUser(store: MessageStore, text: string): void {
  store.append({
    conversationId: 'c1',
    role: 'user',
    content: { role: 'user', data: { text } },
    attachments: [],
    status: 'completed'
  })
}

function addLegacyMarker(store: MessageStore, summary: string, summarizedThroughId: string): void {
  const content: MessageContent = {
    role: 'system',
    data: { kind: 'compacted', payload: { summary, summarizedThroughId, summarizedAt: 1 } }
  }
  store.append({
    conversationId: 'c1',
    role: 'system',
    content,
    attachments: [],
    status: 'completed'
  })
}

// A lossless summarizer: keeps every fact token it was given.
async function keepFacts(input: string): Promise<string> {
  const facts = [...new Set(input.match(/fact-\d+/g) ?? [])]
  return `Earlier in this conversation: ${facts.join(' ')}`
}

function compact(store: MessageStore & { all: Message[] }) {
  return maybeCompact({
    conversationId: 'c1',
    messages: store,
    history: [...store.all],
    summarize: keepFacts,
    estimateLimit: 1,
    currentEstimate: 2
  })
}

function prompt(store: { all: Message[] }): string {
  return assemblePrompt({ history: [...store.all], userMessage: 'next', attachments: [] })
}

function factsIn(text: string): string[] {
  return [...new Set(text.match(/fact-\d+/g) ?? [])].sort()
}

describe('chained compactions', () => {
  it('keeps every message in the prompt across three compactions', async () => {
    const store = fakeStore()
    const written: string[] = []
    for (let round = 0; round < 3; round++) {
      for (let index = 0; index < 10; index++) {
        const fact = `fact-${round * 10 + index}`
        written.push(fact)
        addUser(store, fact)
      }
      expect(await compact(store)).not.toBeNull()
      expect(factsIn(prompt(store))).toEqual([...written].sort())
    }
  })

  it('brings back what two legacy markers dropped, then merges it into one summary', async () => {
    const store = fakeStore()
    for (let index = 1; index <= 4; index++) addUser(store, `fact-${index}`) // m1..m4
    addLegacyMarker(store, 'Earlier in this conversation: fact-1 fact-2', 'm2') // m5
    for (let index = 5; index <= 8; index++) addUser(store, `fact-${index}`) // m6..m9
    // An older build started its window after m5 and summarized m6..m7 without S1.
    addLegacyMarker(store, 'Earlier in this conversation: fact-5 fact-6', 'm7') // m10
    addUser(store, 'fact-9') // m11

    const before = prompt(store)
    expect(factsIn(before)).toEqual(
      [
        'fact-1',
        'fact-2',
        'fact-3',
        'fact-4',
        'fact-5',
        'fact-6',
        'fact-7',
        'fact-8',
        'fact-9'
      ].sort()
    )
    const order = ['fact-1', 'fact-3', 'fact-4', 'fact-5', 'fact-7', 'fact-8', 'fact-9'].map(
      (fact) => before.indexOf(fact)
    )
    expect(order).toEqual([...order].sort((a, b) => a - b))

    expect(await compact(store)).not.toBeNull()
    const after = prompt(store)
    expect(factsIn(after)).toEqual(factsIn(before))
    expect(after.match(/Earlier in this conversation/g)).toHaveLength(1)
  })
})
