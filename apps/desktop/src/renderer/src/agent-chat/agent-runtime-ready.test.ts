import { afterEach, describe, expect, it, vi } from 'vitest'

import { invokeWhenAgentReady } from './agent-runtime-ready'

describe('invokeWhenAgentReady', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('retries while the lazy agent runtime reports runtimeStarting', async () => {
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(
        new Error(
          "Error invoking remote method 'agent:getBackendStatuses': errors:agent.runtimeStarting"
        )
      )
      .mockRejectedValueOnce(new Error("No handler registered for 'agent:getBackendStatuses'"))
      .mockResolvedValue('ready')

    await expect(invokeWhenAgentReady(fn)).resolves.toBe('ready')
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('rejects immediately on an unrelated error', async () => {
    const fn = vi.fn<() => Promise<string>>().mockRejectedValue(new Error('boom'))

    await expect(invokeWhenAgentReady(fn)).rejects.toThrow('boom')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('rejects with the last runtimeStarting error once retries run out', async () => {
    vi.useFakeTimers()
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValue(new Error('errors:agent.runtimeStarting'))

    const result = invokeWhenAgentReady(fn)
    const assertion = expect(result).rejects.toThrow('errors:agent.runtimeStarting')
    await vi.runAllTimersAsync()
    await assertion
    expect(fn).toHaveBeenCalledTimes(40)
  })
})
