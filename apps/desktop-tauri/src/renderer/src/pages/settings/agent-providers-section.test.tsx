import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type * as Bindings from '../../../../generated/bindings'
import { AgentProvidersSection } from './agent-providers-section'

const localProvider = vi.hoisted(() => ({
  agentGetLocalProviderSettings: vi.fn()
}))
vi.mock('../../../../generated/bindings', async (importOriginal) => {
  const actual = await importOriginal<typeof Bindings>()
  return { ...actual, commands: { ...actual.commands, ...localProvider } }
})

describe('AgentProvidersSection permissions', () => {
  beforeEach(() => {
    localProvider.agentGetLocalProviderSettings.mockResolvedValue({
      preset: 'ollama',
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: '',
      apiKeyConfigured: false,
      allowNonLoopback: false,
      thinking: 'default'
    })
    window.api.agent = {
      getPreferences: vi
        .fn()
        .mockResolvedValue({ accessMode: 'vault_only', toolApprovalMode: 'always_accept' }),
      getBackendStatuses: vi.fn().mockResolvedValue({}),
      getToolGrants: vi.fn().mockResolvedValue({ tools: [] })
    } as unknown as typeof window.api.agent
  })

  it('tells the owner that Always allow never unlocks a locked note or folder (#2607)', async () => {
    render(<AgentProvidersSection />)

    expect(
      await screen.findByText(/locked notes and folders stay read-only in both modes/i)
    ).toBeInTheDocument()
  })
})
