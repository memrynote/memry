import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import sodium from 'libsodium-wrappers-sumo'

import * as schema from '@memry/db-schema/data-schema'

vi.mock('../event-bus', () => ({
  broadcastAgentEvent: vi.fn()
}))

vi.mock('../../../telemetry/track', () => ({
  trackMainEvent: vi.fn()
}))

import type { AgentBackendRegistry } from '../../backends/registry'
import type { AgentBackend, BackendRunHandle } from '../../backends/types'
import type { ConversationStore } from '../../storage/conversation-store'
import { createMessageStore, type MessageStore } from '../../storage/message-store'
import type { Conversation } from '../../storage/types'
import { persistToolActivity, summarizeToolArgs } from '../tool-activity'
import { runTurn } from '../turn'

// The persisted transcript is the only copy of a tool row once the renderer has
// dropped it, so these run against the real encrypted store rather than a stub.
function freshDb() {
  const sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE agent_messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content_ciphertext TEXT NOT NULL,
      attachments_ciphertext TEXT NOT NULL,
      tool_call_id TEXT,
      status TEXT NOT NULL,
      vector_clock TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER
    );
  `)
  return drizzle(sqlite, { schema })
}

describe('tool activity persistence', () => {
  let vaultKey: Uint8Array
  let db: ReturnType<typeof freshDb>
  let messages: MessageStore

  beforeAll(async () => {
    await sodium.ready
    vaultKey = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES)
  })

  beforeEach(() => {
    db = freshDb()
    messages = createMessageStore({ db, vaultKey, deviceId: 'device-1' })
  })

  it('keeps the tool rows of a turn in the reloaded transcript', async () => {
    const backend = createFakeBackend({
      turn: [
        {
          kind: 'tool_use',
          toolUseId: 'toolu-1',
          name: 'vault_read_note',
          args: { title: 'Roadmap' }
        },
        { kind: 'tool_result', toolUseId: 'toolu-1', ok: true, data: { text: 'note body' } },
        { kind: 'assistant_delta', text: 'Read it.' },
        { kind: 'message_stop' }
      ]
    })

    await runTurn(
      {
        conversations: createFakeConversationStore(),
        messages,
        backends: createFakeRegistry(backend)
      },
      {
        conversationId: 'conversation-1',
        sourceWindowId: 'window-1',
        text: 'what is on the roadmap?',
        attachments: [],
        backendOptions: { backend: 'claude_cli', claudeEffort: 'low' }
      }
    )

    // Reload — exactly what the renderer re-hydrates with after an eviction.
    const reloaded = messages.listByConversation('conversation-1')
    const toolRows = reloaded.filter((message) => message.role === 'tool_call')

    expect(toolRows).toHaveLength(1)
    expect(toolRows[0].id).toBe('tool-call-toolu-1')
    expect(toolRows[0].toolCallId).toBe('toolu-1')
    expect(toolRows[0].status).toBe('completed')
    expect(toolRows[0].content).toEqual({
      role: 'tool_call',
      data: {
        tool: 'vault_read_note',
        args: { title: 'Roadmap' },
        status: 'output-available'
      }
    })
    // The row sits after the assistant message it belongs to, as it does live.
    expect(reloaded.map((message) => message.role)).toEqual(['user', 'assistant', 'tool_call'])
  })

  it('records a denied tool call as denied', async () => {
    const backend = createFakeBackend({
      turn: [
        {
          kind: 'tool_use',
          toolUseId: 'toolu-2',
          name: 'vault_update_note',
          args: { title: 'Roadmap' }
        },
        {
          kind: 'tool_result',
          toolUseId: 'toolu-2',
          ok: false,
          error: { code: 'PERMISSION_DENIED', message: 'User denied request.' }
        },
        { kind: 'message_stop' }
      ]
    })

    await runTurn(
      {
        conversations: createFakeConversationStore(),
        messages,
        backends: createFakeRegistry(backend)
      },
      {
        conversationId: 'conversation-1',
        sourceWindowId: 'window-1',
        text: 'update the roadmap',
        attachments: [],
        backendOptions: { backend: 'claude_cli', claudeEffort: 'low' }
      }
    )

    const toolRow = messages
      .listByConversation('conversation-1')
      .find((message) => message.role === 'tool_call')

    expect(toolRow?.status).toBe('error')
    expect(toolRow?.content).toEqual({
      role: 'tool_call',
      data: {
        tool: 'vault_update_note',
        args: { title: 'Roadmap' },
        status: 'output-denied',
        error: { code: 'PERMISSION_DENIED', message: 'User denied request.' }
      }
    })
  })

  it('stores neither the tool output nor a whole note body from the args', async () => {
    const noteBody = 'SECRET-BODY '.repeat(200)
    const backend = createFakeBackend({
      turn: [
        {
          kind: 'tool_use',
          toolUseId: 'toolu-3',
          name: 'vault_update_note',
          args: { title: 'Roadmap', content_markdown: noteBody, mode: 'replace' }
        },
        {
          kind: 'tool_result',
          toolUseId: 'toolu-3',
          ok: true,
          data: { note: { markdown: 'WHOLE-NOTE-OUTPUT' } }
        },
        { kind: 'message_stop' }
      ]
    })

    await runTurn(
      {
        conversations: createFakeConversationStore(),
        messages,
        backends: createFakeRegistry(backend)
      },
      {
        conversationId: 'conversation-1',
        sourceWindowId: 'window-1',
        text: 'rewrite the roadmap',
        attachments: [],
        backendOptions: { backend: 'claude_cli', claudeEffort: 'low' }
      }
    )

    const toolRow = messages
      .listByConversation('conversation-1')
      .find((message) => message.role === 'tool_call')
    const stored = JSON.stringify(toolRow?.content)

    expect(stored).not.toContain('WHOLE-NOTE-OUTPUT')
    expect(stored.length).toBeLessThan(noteBody.length)
    expect(toolRow?.content.role === 'tool_call' && toolRow.content.data.args).toEqual({
      title: 'Roadmap',
      content_markdown: `${noteBody.slice(0, 200)}…`,
      mode: 'replace'
    })
  })

  it('does not replay persisted tool rows into the next prompt', async () => {
    const first = createFakeBackend({
      turn: [
        {
          kind: 'tool_use',
          toolUseId: 'toolu-4',
          name: 'vault_read_note',
          args: { title: 'Roadmap' }
        },
        { kind: 'tool_result', toolUseId: 'toolu-4', ok: true, data: {} },
        { kind: 'assistant_delta', text: 'Done.' },
        { kind: 'message_stop' }
      ]
    })
    const conversations = createFakeConversationStore()
    await runTurn(
      { conversations, messages, backends: createFakeRegistry(first) },
      {
        conversationId: 'conversation-1',
        sourceWindowId: 'window-1',
        text: 'first',
        attachments: [],
        backendOptions: { backend: 'claude_cli', claudeEffort: 'low' }
      }
    )

    const second = createFakeBackend({ turn: [{ kind: 'message_stop' }] })
    await runTurn(
      { conversations, messages, backends: createFakeRegistry(second) },
      {
        conversationId: 'conversation-1',
        sourceWindowId: 'window-1',
        text: 'second',
        attachments: [],
        backendOptions: { backend: 'claude_cli', claudeEffort: 'low' }
      }
    )

    const prompt = second.runTurn.mock.calls[0][0].prompt as string
    expect(prompt).toContain('User: first')
    expect(prompt).toContain('Assistant: Done.')
    // The tool catalogue names the tools; the transcript must not replay them.
    expect(prompt).not.toContain('Tool call:')
    expect(prompt.slice(prompt.indexOf('--- Prior turns ---'))).not.toContain('vault_read_note')
  })

  it('loads a legacy conversation that has no persisted tool rows', async () => {
    messages.append({
      conversationId: 'legacy-1',
      role: 'user',
      content: { role: 'user', data: { text: 'older build wrote this' } },
      attachments: [],
      status: 'completed'
    })
    messages.append({
      conversationId: 'legacy-1',
      role: 'assistant',
      content: { role: 'assistant', data: { text: 'and this' } },
      attachments: [],
      status: 'completed'
    })

    const reloaded = messages.listByConversation('legacy-1')
    expect(reloaded.map((message) => message.role)).toEqual(['user', 'assistant'])
    expect(reloaded.some((message) => message.role === 'tool_call')).toBe(false)

    const backend = createFakeBackend({ turn: [{ kind: 'message_stop' }] })
    await expect(
      runTurn(
        {
          conversations: createFakeConversationStore(),
          messages,
          backends: createFakeRegistry(backend)
        },
        {
          conversationId: 'legacy-1',
          sourceWindowId: 'window-1',
          text: 'continue',
          attachments: [],
          backendOptions: { backend: 'claude_cli', claudeEffort: 'low' }
        }
      )
    ).resolves.toEqual({ turnId: expect.any(String) })
  })

  it('never fails a turn because the row could not be written', () => {
    persistToolActivity(messages, {
      conversationId: 'conversation-1',
      toolCallId: 'toolu-dup',
      name: 'vault_read_note',
      args: {},
      outcome: { ok: true }
    })

    expect(() =>
      persistToolActivity(messages, {
        conversationId: 'conversation-1',
        toolCallId: 'toolu-dup',
        name: 'vault_read_note',
        args: {},
        outcome: { ok: true }
      })
    ).not.toThrow()
    expect(messages.listByConversation('conversation-1')).toHaveLength(1)
  })

  it('marks an unlabelled failure as an error rather than a denial', () => {
    persistToolActivity(messages, {
      conversationId: 'conversation-1',
      toolCallId: 'toolu-5',
      name: 'vault_search_notes',
      args: {},
      outcome: { ok: false, error: undefined }
    })

    const row = messages.listByConversation('conversation-1')[0]
    expect(row.content.role === 'tool_call' && row.content.data.status).toBe('output-error')
  })

  describe('summarizeToolArgs', () => {
    it('drops nested payloads and non-object args', () => {
      expect(summarizeToolArgs({ query: 'roadmap', filters: { tag: 'x' }, ids: [1, 2] })).toEqual({
        query: 'roadmap'
      })
      expect(summarizeToolArgs('not an object')).toEqual({})
      expect(summarizeToolArgs([1, 2])).toEqual({})
      expect(summarizeToolArgs(null)).toEqual({})
    })

    it('keeps scalars and caps the number of keys', () => {
      const args = Object.fromEntries(
        Array.from({ length: 20 }, (_, index) => [`key-${index}`, index])
      )
      expect(Object.keys(summarizeToolArgs(args))).toHaveLength(12)
      expect(summarizeToolArgs({ limit: 5, recursive: true, cursor: null })).toEqual({
        limit: 5,
        recursive: true,
        cursor: null
      })
    })
  })
})

function createFakeConversationStore(overrides: Partial<Conversation> = {}): ConversationStore {
  const conversation = {
    id: 'conversation-1',
    vaultId: 'vault-1',
    title: 'Existing conversation',
    backend: 'claude_cli',
    backendModel: null,
    trustList: [],
    pinned: false,
    vectorClock: {},
    fieldClocks: {},
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
    lastSyncedAt: null,
    ...overrides
  }

  return {
    create: vi.fn(),
    getById: vi.fn(() => conversation),
    listByVault: vi.fn(() => [conversation]),
    update: vi.fn((_id, patch) => ({ ...conversation, ...patch, updatedAt: 2 })),
    softDelete: vi.fn(),
    addToTrustList: vi.fn(),
    removeFromTrustList: vi.fn()
  }
}

function createFakeRegistry(backend: AgentBackend): AgentBackendRegistry {
  return {
    get: vi.fn(() => backend),
    list: vi.fn(() => [backend])
  }
}

function createFakeBackend(input: {
  turn: BackendRunHandle['events'] extends AsyncIterable<infer Event> ? Event[] : never
}): AgentBackend & { runTurn: ReturnType<typeof vi.fn> } {
  return {
    id: 'claude_cli',
    runTurn: vi.fn(async () => createRunHandle(input.turn)),
    generateTitle: vi.fn(async () => createRunHandle([])),
    summarize: vi.fn(async () => createRunHandle([])),
    cancel: vi.fn(),
    getStatus: vi.fn(async () => ({ backend: 'claude_cli' as const, available: true })),
    probeCapabilities: vi.fn()
  }
}

function createRunHandle(
  events: BackendRunHandle['events'] extends AsyncIterable<infer Event> ? Event[] : never
): BackendRunHandle {
  return {
    events: (async function* () {
      yield* events
    })(),
    stderr: (async function* () {})(),
    pid: 1234,
    kill: vi.fn(),
    waitExit: vi.fn(async () => 0),
    cleanup: vi.fn(async () => {})
  }
}
