import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { AgentProvidersSection } from './agent-providers-section'

describe('AgentProvidersSection', () => {
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
      getToolGrants: vi.fn().mockResolvedValue({ tools: [] }),
      setLocalProviderSettings: vi.fn(async (input: Record<string, unknown>) => input),
      testLocalProvider: vi.fn().mockResolvedValue(null)
    } as unknown as typeof window.api.agent
  })

  it('tells the owner that Always allow never unlocks a locked note or folder (#2607)', async () => {
    render(<AgentProvidersSection />)

    expect(
      await screen.findByText(/locked notes and folders stay read-only in both modes/i)
    ).toBeInTheDocument()
  })

  // #3674: the edit auto-saves after a debounce, and leaving the page inside that window
  // used to drop it, so the chat kept running against the old model.
  it('saves a local model edit when the page closes before the debounce fires', async () => {
    const { unmount } = render(<AgentProvidersSection />)
    fireEvent.click(await screen.findByRole('button', { name: /Local model/ }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Model' }), {
      target: { value: 'qwen3' }
    })

    unmount()

    expect(window.api.agent.setLocalProviderSettings).toHaveBeenCalledWith(
      expect.objectContaining({ preset: 'ollama', model: 'qwen3' })
    )
  })
})
