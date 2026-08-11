import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  setWriteGate: vi.fn()
}))

vi.mock('../../mcp/lifecycle', () => ({
  setWriteGate: mocks.setWriteGate
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
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('kills only subprocesses for the cancelled conversation', () => {
    const agentRuntime = runtime()
    const firstKill = vi.fn()
    const secondKill = vi.fn()

    agentRuntime.trackSubprocess('conversation-1', {
      pid: 1,
      kill: firstKill,
      waitExit: async () => 0
    })
    agentRuntime.trackSubprocess('conversation-2', {
      pid: 2,
      kill: secondKill,
      waitExit: async () => 0
    })

    agentRuntime.cancelTurn('conversation-1')

    expect(firstKill).toHaveBeenCalledTimes(1)
    expect(secondKill).not.toHaveBeenCalled()
  })

  it('does not kill a subprocess after it is untracked', () => {
    const agentRuntime = runtime()
    const kill = vi.fn()

    agentRuntime.trackSubprocess('conversation-1', { pid: 1, kill, waitExit: async () => 0 })
    agentRuntime.untrackSubprocess(1)
    agentRuntime.cancelTurn('conversation-1')

    expect(kill).not.toHaveBeenCalled()
  })

  it('kills subprocesses, waits for active turns, and clears the MCP write gate on shutdown', async () => {
    const agentRuntime = runtime()
    const kill = vi.fn()
    const activeTurn = deferred<void>()

    agentRuntime.trackSubprocess('conversation-1', { pid: 1, kill, waitExit: async () => 0 })
    agentRuntime.trackTurn('conversation-1', activeTurn.promise)

    let shutdownSettled = false
    const shutdown = agentRuntime.killAll().then(() => {
      shutdownSettled = true
    })

    await Promise.resolve()

    expect(kill).toHaveBeenCalledTimes(1)
    expect(shutdownSettled).toBe(false)

    activeTurn.resolve()
    await shutdown

    expect(shutdownSettled).toBe(true)
    expect(mocks.setWriteGate).toHaveBeenLastCalledWith(null)
  })
})

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}
