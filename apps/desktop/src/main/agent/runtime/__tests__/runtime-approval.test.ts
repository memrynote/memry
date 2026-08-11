import { beforeEach, describe, expect, it, vi } from 'vitest'

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

import type { VaultServiceHandles } from '../../mcp/tools/handles'
import { buildWriteTools } from '../../mcp/tools/write-tools'
import type { ConversationStore } from '../../storage/conversation-store'
import type { MessageStore } from '../../storage/message-store'
import { AgentRuntime } from '../runtime'

/** Drains every queued microtask so an already-settled promise wins a race. */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function broadcastToolCallIds(): string[] {
  return mocks.broadcastAgentEvent.mock.calls
    .map(([event]) => event as { kind: string; toolCallId: string })
    .filter((event) => event.kind === 'tool_call_pending_approval')
    .map((event) => event.toolCallId)
}

function createRuntime(toolApprovalMode: 'always_accept' | 'ask' = 'always_accept') {
  const conversations = {
    getById: vi.fn(),
    addToTrustList: vi.fn()
  }
  const runtime = new AgentRuntime({
    conversations: conversations as unknown as ConversationStore,
    messages: {} as MessageStore,
    getPreferences: () => ({ accessMode: 'vault_only', toolApprovalMode })
  })

  return { runtime, conversations }
}

function installedGate() {
  const gate = mocks.setWriteGate.mock.calls[0]?.[0]
  if (!gate) throw new Error('write gate was not installed')
  return gate
}

describe('AgentRuntime approval gate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(Date, 'now').mockReturnValue(100)
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
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
