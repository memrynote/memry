import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentBackendId } from '@memry/contracts/ipc-agent'

const available = new Map<AgentBackendId, boolean>()
const getStatus = vi.fn(async (id: AgentBackendId) => ({ available: available.get(id) ?? false }))

vi.mock('../agent/backends/active-registry', () => ({
  getActiveBackends: () => ({ get: (id: AgentBackendId) => ({ getStatus: () => getStatus(id) }) })
}))
vi.mock('../agent/backends/local-provider-settings', () => ({
  getLocalProviderSettings: async () => ({ model: '' })
}))
vi.mock('../agent/backends/structured-completion', () => ({ completeStructured: vi.fn() }))
vi.mock('../agent/lazy-services', () => ({ ensureLazyAgentServicesStarted: async () => {} }))

import { getFoldAgentStatus, resetFoldAgentDetection, resolveFoldAgent } from './agent'

describe('fold agent chooser', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    available.clear()
    getStatus.mockClear()
    resetFoldAgentDetection()
  })
  afterEach(() => vi.useRealTimers())

  it('auto picks the first detected agent in claude, codex, antigravity, local order', async () => {
    available.set('codex_cli', true)
    available.set('local_openai_compatible', true)
    expect((await resolveFoldAgent('auto'))?.label).toBe('Codex')
  })

  it('a chosen agent is used even when an earlier one is available', async () => {
    available.set('claude_cli', true)
    available.set('antigravity_cli', true)
    expect((await resolveFoldAgent('antigravity_cli'))?.label).toBe('Antigravity')
  })

  it('a chosen but unavailable agent resolves to none instead of another agent', async () => {
    available.set('claude_cli', true)
    expect(await resolveFoldAgent('codex_cli')).toBeNull()
    const status = await getFoldAgentStatus('codex_cli')
    expect(status.resolved).toBeNull()
    expect(status.available).toEqual([{ id: 'claude_cli', label: 'Claude' }])
  })

  it('keys the cache by agent: switching the choice changes the model id', async () => {
    available.set('claude_cli', true)
    available.set('codex_cli', true)
    const a = await resolveFoldAgent('claude_cli')
    const b = await resolveFoldAgent('codex_cli')
    expect(a?.modelId).not.toBe(b?.modelId)
  })

  it('re-detects a "no agent" result after a few seconds, but keeps a found agent for a minute', async () => {
    expect(await resolveFoldAgent('auto')).toBeNull()
    available.set('claude_cli', true)
    expect(await resolveFoldAgent('auto')).toBeNull()
    await vi.advanceTimersByTimeAsync(6_000)
    expect((await resolveFoldAgent('auto'))?.label).toBe('Claude')

    available.clear()
    await vi.advanceTimersByTimeAsync(30_000)
    expect((await resolveFoldAgent('auto'))?.label).toBe('Claude')
    await vi.advanceTimersByTimeAsync(31_000)
    expect(await resolveFoldAgent('auto')).toBeNull()
  })

  it('resetting detection (settings changed) re-probes at once', async () => {
    available.set('claude_cli', true)
    await resolveFoldAgent('auto')
    available.clear()
    resetFoldAgentDetection()
    expect(await resolveFoldAgent('auto')).toBeNull()
  })
})
