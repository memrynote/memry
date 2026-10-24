import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { AgentProvidersSection } from './agent-providers-section'

describe('AgentProvidersSection permissions', () => {
  beforeEach(() => {
    window.api.agent = {
      getLocalProviderSettings: vi.fn().mockResolvedValue({
        preset: 'ollama',
        baseUrl: 'http://127.0.0.1:11434/v1',
        model: '',
        hasApiKey: false
      }),
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
