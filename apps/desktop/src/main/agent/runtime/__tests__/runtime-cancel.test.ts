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

describe('AgentRuntime subprocess cancellation', () => {
  it('kills only subprocesses for the cancelled conversation', () => {
    const agentRuntime = runtime()
    const firstKill = vi.fn()
    const secondKill = vi.fn()

    agentRuntime.trackSubprocess('conversation-1', { pid: 1, kill: firstKill })
    agentRuntime.trackSubprocess('conversation-2', { pid: 2, kill: secondKill })

    agentRuntime.cancelTurn('conversation-1')

    expect(firstKill).toHaveBeenCalledTimes(1)
    expect(secondKill).not.toHaveBeenCalled()
  })

  it('does not kill a subprocess after it is untracked', () => {
    const agentRuntime = runtime()
    const kill = vi.fn()

    agentRuntime.trackSubprocess('conversation-1', { pid: 1, kill })
    agentRuntime.untrackSubprocess(1)
    agentRuntime.cancelTurn('conversation-1')

    expect(kill).not.toHaveBeenCalled()
  })
})
