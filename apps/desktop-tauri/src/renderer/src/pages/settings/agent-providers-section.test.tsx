import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type * as Bindings from '../../../../generated/bindings'
import { AgentProvidersSection } from './agent-providers-section'

const localProvider = vi.hoisted(() => ({
  agentGetLocalProviderSettings: vi.fn(),
  agentGetToolGrants: vi.fn(),
  agentEditVaultTrustList: vi.fn()
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
    localProvider.agentGetToolGrants.mockResolvedValue({ tools: [] })
    window.api.agent = {
      getPreferences: vi
        .fn()
        .mockResolvedValue({ accessMode: 'vault_only', toolApprovalMode: 'always_accept' }),
      getBackendStatuses: vi.fn().mockResolvedValue({})
    } as unknown as typeof window.api.agent
  })

  it('tells the owner that Always allow never unlocks a locked note or folder (#2607)', async () => {
    render(<AgentProvidersSection />)

    expect(
      await screen.findByText(/locked notes and folders stay read-only in both modes/i)
    ).toBeInTheDocument()
  })

  it('revokes a standing approval through Rust and lists what is left', async () => {
    localProvider.agentGetToolGrants.mockResolvedValue({
      tools: ['vault_create_task', 'vault_tag_note']
    })
    localProvider.agentEditVaultTrustList.mockResolvedValue({ tools: ['vault_tag_note'] })
    render(<AgentProvidersSection />)

    expect(await screen.findByText('vault_create_task')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /vault_create_task/ }))

    await waitFor(() => expect(screen.queryByText('vault_create_task')).not.toBeInTheDocument())
    expect(localProvider.agentEditVaultTrustList).toHaveBeenCalledWith({
      remove: ['vault_create_task']
    })
    expect(screen.getByText('vault_tag_note')).toBeInTheDocument()
  })
})
