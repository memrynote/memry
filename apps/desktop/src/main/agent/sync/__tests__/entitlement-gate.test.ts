import { describe, expect, it, vi } from 'vitest'

import { createAgentSyncEntitlementGate } from '../entitlement-gate'

describe('Agent sync entitlement gate', () => {
  it('does not enqueue for free users', async () => {
    const enqueue = vi.fn()
    const gate = createAgentSyncEntitlementGate({ isPaid: () => false, enqueue })

    await gate.maybeEnqueue({ type: 'agent_message', id: 'm1' })

    expect(enqueue).not.toHaveBeenCalled()
  })

  it('enqueues for paid users', async () => {
    const enqueue = vi.fn()
    const gate = createAgentSyncEntitlementGate({ isPaid: () => true, enqueue })

    await gate.maybeEnqueue({ type: 'agent_message', id: 'm1' })

    expect(enqueue).toHaveBeenCalledWith({ type: 'agent_message', id: 'm1' })
  })

  it('reads entitlement at enqueue time', async () => {
    const enqueue = vi.fn()
    let isPaid = false
    const gate = createAgentSyncEntitlementGate({ isPaid: () => isPaid, enqueue })

    await gate.maybeEnqueue({ type: 'agent_message', id: 'm1' })
    expect(enqueue).not.toHaveBeenCalled()

    isPaid = true
    await gate.maybeEnqueue({ type: 'agent_message', id: 'm2' })
    expect(enqueue).toHaveBeenCalledWith({ type: 'agent_message', id: 'm2' })
  })

  it('does not enqueue streaming messages', async () => {
    const enqueue = vi.fn()
    const gate = createAgentSyncEntitlementGate({ isPaid: () => true, enqueue })

    await gate.maybeEnqueue({ type: 'agent_message', id: 'm1', status: 'streaming' })

    expect(enqueue).not.toHaveBeenCalled()
  })
})
