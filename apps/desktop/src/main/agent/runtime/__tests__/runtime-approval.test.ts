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

import type { ConversationStore } from '../../storage/conversation-store'
import type { MessageStore } from '../../storage/message-store'
import { AgentRuntime } from '../runtime'

function createRuntime(toolApprovalMode: 'always_accept' | 'ask' = 'always_accept') {
  const conversations = {
    getById: vi.fn(),
    addToTrustList: vi.fn()
  }
  const runtime = new AgentRuntime({
    conversations: conversations as unknown as ConversationStore,
    messages: {} as MessageStore,
    getPreferences: () => ({ toolApprovalMode })
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
