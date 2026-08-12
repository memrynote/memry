import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import sodium from 'libsodium-wrappers-sumo'

const mocks = vi.hoisted(() => ({
  setWriteGate: vi.fn(),
  broadcastAgentEvent: vi.fn()
}))

vi.mock('../../mcp/lifecycle', () => ({
  setWriteGate: mocks.setWriteGate
}))

vi.mock('../event-bus', () => ({
  broadcastAgentEvent: mocks.broadcastAgentEvent
}))

import * as schema from '@memry/db-schema/data-schema'
import type { VaultServiceHandles } from '../../mcp/tools/handles'
import { buildWriteTools } from '../../mcp/tools/write-tools'
import type { ConversationStore } from '../../storage/conversation-store'
import { createConversationStore } from '../../storage/conversation-store'
import type { MessageStore } from '../../storage/message-store'
import { AgentRuntime } from '../runtime'

/** Drains every queued microtask so an already-settled promise wins a race. */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/**
 * Real timers, not fake ones: the runtime's deadline is a real `setTimeout` and
 * these tests assert it fires (and does not fire) on its own.
 */
const APPROVAL_TIMEOUT_TEST_MS = 15

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function broadcastToolCallIds(): string[] {
  return mocks.broadcastAgentEvent.mock.calls
    .map(([event]) => event as { kind: string; toolCallId: string })
    .filter((event) => event.kind === 'tool_call_pending_approval')
    .map((event) => event.toolCallId)
}

function failedToolCallEvents(): {
  toolCallId: string
  error: { code: string; message: string }
}[] {
  return mocks.broadcastAgentEvent.mock.calls
    .map(
      ([event]) =>
        event as { kind: string; toolCallId: string; error: { code: string; message: string } }
    )
    .filter((event) => event.kind === 'tool_call_failed')
}

function createRuntime(
  toolApprovalMode: 'always_accept' | 'ask' = 'always_accept',
  approvalTimeoutMs?: number
) {
  const conversations = {
    getById: vi.fn(),
    addToTrustList: vi.fn()
  }
  const runtime = new AgentRuntime({
    conversations: conversations as unknown as ConversationStore,
    messages: {} as MessageStore,
    getPreferences: () => ({ accessMode: 'vault_only', toolApprovalMode }),
    approvalTimeoutMs
  })

  return { runtime, conversations }
}

function installedGate() {
  const gate = mocks.setWriteGate.mock.calls[0]?.[0]
  if (!gate) throw new Error('write gate was not installed')
  return gate
}

/**
 * Same runtime, but wired to a real SQLite-backed ConversationStore instead of
 * a `vi.fn()`. The tombstone bug lives in the store's SQL, so a mocked store
 * cannot see it.
 */
function createRuntimeWithRealStore(vaultKey: Uint8Array) {
  const sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE agent_conversations (
      id TEXT PRIMARY KEY,
      vault_id TEXT NOT NULL,
      title_ciphertext TEXT NOT NULL,
      backend TEXT NOT NULL,
      backend_model TEXT,
      trust_list TEXT NOT NULL DEFAULT '[]',
      pinned INTEGER NOT NULL DEFAULT 0,
      vector_clock TEXT NOT NULL,
      field_clocks TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER,
      last_synced_at INTEGER
    );
  `)
  const conversations = createConversationStore({
    db: drizzle(sqlite, { schema }),
    vaultKey,
    deviceId: 'device-1'
  })
  const runtime = new AgentRuntime({
    conversations,
    messages: {} as MessageStore,
    getPreferences: () => ({ accessMode: 'vault_only', toolApprovalMode: 'always_accept' })
  })

  return { runtime, conversations }
}

describe('AgentRuntime approval gate', () => {
  let vaultKey: Uint8Array

  beforeAll(async () => {
    await sodium.ready
    vaultKey = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES)
  })

  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(Date, 'now').mockReturnValue(100)
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
  })

  it('rejects writes into a soft-deleted conversation', async () => {
    const { runtime, conversations } = createRuntimeWithRealStore(vaultKey)
    const conversation = conversations.create({
      vaultId: 'v',
      title: 'Doomed',
      backend: 'claude_cli'
    })

    runtime.install()
    const gate = installedGate()
    const write = {
      conversationId: conversation.id,
      toolName: 'vault_create_task',
      parsedArgs: { title: 'Task' }
    }

    await expect(gate(write)).resolves.toEqual({ approved: true })

    // A remote delete applied by the sync handler leaves exactly this state.
    conversations.softDelete(conversation.id)

    await expect(gate(write)).resolves.toEqual({
      approved: false,
      reason: 'Unknown conversation'
    })
  })

  it('rejects writes for unknown conversations', async () => {
    const { runtime, conversations } = createRuntime()
    conversations.getById.mockReturnValue(null)

    runtime.install()

    await expect(
      installedGate()({
        conversationId: 'missing',
        toolName: 'vault_create_task',
        parsedArgs: { title: 'Task' }
      })
    ).resolves.toEqual({ approved: false, reason: 'Unknown conversation' })
  })

  it('auto-approves write tools by default without queuing an approval', async () => {
    const { runtime, conversations } = createRuntime()
    conversations.getById.mockReturnValue({ id: 'conversation-1', trustList: [] })

    runtime.install()
    const gate = installedGate()

    await expect(
      gate({
        conversationId: 'conversation-1',
        toolName: 'vault_update_note',
        parsedArgs: { id: 'note-1', content_markdown: 'Draft' }
      })
    ).resolves.toEqual({ approved: true })
    expect(mocks.broadcastAgentEvent).not.toHaveBeenCalled()
    expect(runtime.getPendingApproval('gate-100-i')).toBeNull()
  })

  it('auto-approves read and trusted create tools in manual mode', async () => {
    const { runtime, conversations } = createRuntime('ask')
    conversations.getById.mockReturnValue({
      id: 'conversation-1',
      trustList: ['vault_create_task']
    })

    runtime.install()
    const gate = installedGate()

    await expect(
      gate({ conversationId: 'conversation-1', toolName: 'vault_read_note', parsedArgs: {} })
    ).resolves.toEqual({ approved: true })
    await expect(
      gate({
        conversationId: 'conversation-1',
        toolName: 'vault_create_task',
        parsedArgs: { title: 'Task' }
      })
    ).resolves.toEqual({ approved: true })
    expect(mocks.broadcastAgentEvent).not.toHaveBeenCalled()
  })

  it('waits for user approval and applies allow-always trust changes', async () => {
    const { runtime, conversations } = createRuntime('ask')
    conversations.getById.mockReturnValue({ id: 'conversation-1', trustList: [] })

    runtime.install()
    const pending = installedGate()({
      conversationId: 'conversation-1',
      toolName: 'vault_create_task',
      parsedArgs: { title: 'Task' }
    })

    expect(mocks.broadcastAgentEvent).toHaveBeenCalledWith({
      kind: 'tool_call_pending_approval',
      conversationId: 'conversation-1',
      toolCallId: 'gate-100-i',
      name: 'vault_create_task',
      args: { title: 'Task' },
      requiresDiff: false
    })
    expect(runtime.getPendingApproval('gate-100-i')).toEqual({
      conversationId: 'conversation-1',
      toolCallId: 'gate-100-i',
      name: 'vault_create_task',
      args: { title: 'Task' },
      requiresDiff: false
    })

    runtime.resolveApproval('gate-100-i', { kind: 'allow_always' })

    await expect(pending).resolves.toEqual({ approved: true, args: { title: 'Task' } })
    expect(conversations.addToTrustList).toHaveBeenCalledWith('conversation-1', 'vault_create_task')
    expect(runtime.getPendingApproval('gate-100-i')).toBeNull()
  })

  it('returns edited args and denial decisions from pending approvals', async () => {
    const { runtime, conversations } = createRuntime('ask')
    conversations.getById.mockReturnValue({ id: 'conversation-1', trustList: [] })

    runtime.install()
    const gate = installedGate()

    const edited = gate({
      conversationId: 'conversation-1',
      toolName: 'vault_update_note',
      parsedArgs: { id: 'note-1', content_markdown: 'Original' }
    })
    runtime.resolveApproval('gate-100-i', {
      kind: 'edit_allow',
      editedArgs: { id: 'note-1', content_markdown: 'Edited' }
    })
    await expect(edited).resolves.toEqual({
      approved: true,
      args: { id: 'note-1', content_markdown: 'Edited' }
    })

    const denied = gate({
      conversationId: 'conversation-1',
      toolName: 'vault_add_tag',
      parsedArgs: { id: 'note-1', tag: 'focus' }
    })
    runtime.resolveApproval('gate-100-i', { kind: 'deny', reason: 'Not now' })
    await expect(denied).resolves.toEqual({
      approved: false,
      reason: 'User denied request.'
    })
  })

  it('denies pending approvals for the cancelled conversation only', async () => {
    const { runtime, conversations } = createRuntime('ask')
    conversations.getById.mockImplementation((id: string) => ({ id, trustList: [] }))
    vi.spyOn(Date, 'now').mockReturnValueOnce(100).mockReturnValueOnce(200)

    runtime.install()
    const gate = installedGate()
    const cancelled = gate({
      conversationId: 'conversation-1',
      toolName: 'vault_create_task',
      parsedArgs: { title: 'Task' }
    })
    const untouched = gate({
      conversationId: 'conversation-2',
      toolName: 'vault_create_task',
      parsedArgs: { title: 'Other task' }
    })
    const [cancelledId, untouchedId] = broadcastToolCallIds()
    expect(cancelledId).not.toBe(untouchedId)

    runtime.cancelTurn('conversation-1')
    await flushMicrotasks()

    await expect(
      Promise.race([cancelled, Promise.resolve('still-pending' as const)])
    ).resolves.toEqual({ approved: false, reason: 'User denied request.' })
    expect(runtime.getPendingApproval(cancelledId)).toBeNull()
    expect(mocks.broadcastAgentEvent).toHaveBeenCalledWith({
      kind: 'tool_call_failed',
      conversationId: 'conversation-1',
      toolCallId: cancelledId,
      error: { code: 'PERMISSION_DENIED', message: 'Turn cancelled before approval.' }
    })

    await expect(
      Promise.race([untouched, Promise.resolve('still-pending' as const)])
    ).resolves.toBe('still-pending')
    expect(runtime.getPendingApproval(untouchedId)).not.toBeNull()
  })

  it('fails the awaiting write tool with PERMISSION_DENIED and never executes it on cancel', async () => {
    const { runtime, conversations } = createRuntime('ask')
    conversations.getById.mockReturnValue({ id: 'conversation-1', trustList: [] })

    runtime.install()
    const create = vi.fn(async () => ({ id: 'note-1' }))
    const createNote = buildWriteTools(
      { notes: { create } } as unknown as VaultServiceHandles,
      installedGate()
    ).find((tool) => tool.name === 'vault_create_note')
    if (!createNote) throw new Error('vault_create_note is not registered')

    const call = createNote.handler(
      { title: 'Notes', content_markdown: 'body' },
      { conversationId: 'conversation-1', windowId: null }
    )
    const settled = call.then(
      () => 'resolved-as-approved' as const,
      (error: unknown) => error
    )
    expect(runtime.getPendingApproval('gate-100-i')).not.toBeNull()

    runtime.cancelTurn('conversation-1')
    await flushMicrotasks()

    await expect(
      Promise.race([settled, Promise.resolve('still-pending' as const)])
    ).resolves.toMatchObject({ code: 'PERMISSION_DENIED' })
    expect(create).not.toHaveBeenCalled()
  })

  it('settles an unanswered approval as expired, not as a denial', async () => {
    const { runtime, conversations } = createRuntime('ask', APPROVAL_TIMEOUT_TEST_MS)
    conversations.getById.mockReturnValue({ id: 'conversation-1', trustList: [] })

    runtime.install()
    const pending = installedGate()({
      conversationId: 'conversation-1',
      toolName: 'vault_create_task',
      parsedArgs: { title: 'Task' }
    })
    const [toolCallId] = broadcastToolCallIds()
    expect(runtime.getPendingApproval(toolCallId)).not.toBeNull()

    await delay(APPROVAL_TIMEOUT_TEST_MS * 8)

    // The map entry is gone, so the tool handler, its socket and the args it
    // pinned are all released without anyone touching the app.
    expect(runtime.getPendingApproval(toolCallId)).toBeNull()
    const settled = await Promise.race([pending, Promise.resolve('still-pending' as const)])
    expect(settled).toEqual({
      approved: false,
      reason: expect.stringContaining('expired') as string
    })
    // The model must not be told the user refused.
    expect((settled as { reason: string }).reason).not.toContain('denied')

    const failure = failedToolCallEvents().find((event) => event.toolCallId === toolCallId)
    expect(failure?.error).toEqual({
      code: 'APPROVAL_EXPIRED',
      message: expect.stringContaining('expired') as string
    })
    // PERMISSION_DENIED is what the renderer renders as the "Denied" chip.
    expect(failure?.error.code).not.toBe('PERMISSION_DENIED')
  })

  it('fails the awaiting write tool on expiry and never executes it', async () => {
    const { runtime, conversations } = createRuntime('ask', APPROVAL_TIMEOUT_TEST_MS)
    conversations.getById.mockReturnValue({ id: 'conversation-1', trustList: [] })

    runtime.install()
    const create = vi.fn(async () => ({ id: 'note-1' }))
    const createNote = buildWriteTools(
      { notes: { create } } as unknown as VaultServiceHandles,
      installedGate()
    ).find((tool) => tool.name === 'vault_create_note')
    if (!createNote) throw new Error('vault_create_note is not registered')

    const settled = createNote
      .handler(
        { title: 'Notes', content_markdown: 'body' },
        { conversationId: 'conversation-1', windowId: null }
      )
      .then(
        () => 'resolved-as-approved' as const,
        (error: unknown) => error
      )

    await delay(APPROVAL_TIMEOUT_TEST_MS * 8)

    await expect(
      Promise.race([settled, Promise.resolve('still-pending' as const)])
    ).resolves.toMatchObject({ message: expect.stringContaining('expired') as string })
    expect(create).not.toHaveBeenCalled()
  })

  it('cancels the deadline when the user decides in time', async () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout')
    const { runtime, conversations } = createRuntime('ask', APPROVAL_TIMEOUT_TEST_MS)
    conversations.getById.mockReturnValue({ id: 'conversation-1', trustList: [] })

    runtime.install()
    const pending = installedGate()({
      conversationId: 'conversation-1',
      toolName: 'vault_create_task',
      parsedArgs: { title: 'Task' }
    })
    const [toolCallId] = broadcastToolCallIds()

    runtime.resolveApproval(toolCallId, { kind: 'allow' })
    await expect(pending).resolves.toEqual({ approved: true, args: { title: 'Task' } })
    expect(clearTimeoutSpy).toHaveBeenCalled()

    await delay(APPROVAL_TIMEOUT_TEST_MS * 8)

    // An orphaned timer would fire here and broadcast a failure for a tool call
    // the user already approved.
    expect(failedToolCallEvents()).toEqual([])
    clearTimeoutSpy.mockRestore()
  })

  /**
   * Guards the deliberate decision NOT to truncate retained args: `previewDiff`
   * reads this snapshot to build the approval diff, so a slice would show the
   * user a partial version of what they are consenting to.
   */
  it('keeps the full args a pending approval was raised with', async () => {
    const { runtime, conversations } = createRuntime('ask')
    conversations.getById.mockReturnValue({ id: 'conversation-1', trustList: [] })

    runtime.install()
    const args = { id: 'note-1', content_markdown: 'x'.repeat(64 * 1024) }
    void installedGate()({
      conversationId: 'conversation-1',
      toolName: 'vault_update_note',
      parsedArgs: args
    })
    const [toolCallId] = broadcastToolCallIds()

    expect(runtime.getPendingApproval(toolCallId)?.args).toEqual(args)
    runtime.cancelTurn('conversation-1')
  })

  it('denies pending approvals and clears the MCP write gate on shutdown', async () => {
    const { runtime, conversations } = createRuntime('ask')
    conversations.getById.mockReturnValue({ id: 'conversation-1', trustList: [] })

    runtime.install()
    const pending = installedGate()({
      conversationId: 'conversation-1',
      toolName: 'vault_create_task',
      parsedArgs: { title: 'Task' }
    })

    await runtime.killAll()

    const result = await Promise.race([
      pending,
      Promise.resolve({ approved: 'still-pending' as const })
    ])

    expect(result).toEqual({ approved: false, reason: 'User denied request.' })
    expect(runtime.getPendingApproval('gate-100-i')).toBeNull()
    expect(mocks.setWriteGate).toHaveBeenLastCalledWith(null)
  })
})
