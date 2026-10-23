import { describe, expect, it, vi } from 'vitest'

vi.mock('../../mcp/lifecycle', () => ({
  setWriteGate: vi.fn()
}))

import type { ConversationStore } from '../../storage/conversation-store'
import type { MessageStore } from '../../storage/message-store'
import { AgentRuntime } from '../runtime'

function runtime(): AgentRuntime {
  return new AgentRuntime({
    conversations: {} as ConversationStore,
    messages: {} as MessageStore,
    spawn: vi.fn() as never
  })
}

describe('AgentRuntime concurrent-turn lock', () => {
  it('rejects a second send for a conversation that already has a turn in flight', () => {
    const agentRuntime = runtime()

    agentRuntime.acquireTurnLock('conversation-1')

    expect(() => agentRuntime.acquireTurnLock('conversation-1')).toThrow(
      /already a turn in flight/i
    )
  })

  it('releases the lock when explicitly cleared', () => {
    const agentRuntime = runtime()

    agentRuntime.acquireTurnLock('conversation-1')
    agentRuntime.releaseTurnLock('conversation-1')

    expect(() => agentRuntime.acquireTurnLock('conversation-1')).not.toThrow()
  })

  it('locks per conversation, not globally', () => {
    const agentRuntime = runtime()

    agentRuntime.acquireTurnLock('conversation-1')

    expect(() => agentRuntime.acquireTurnLock('conversation-2')).not.toThrow()
  })
})
