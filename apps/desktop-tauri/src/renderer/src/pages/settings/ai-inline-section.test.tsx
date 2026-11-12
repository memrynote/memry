import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import type { InlineAiSettings } from '../../../../generated/bindings'

const MASKED = '\u2022'.repeat(8)

const commands = vi.hoisted(() => ({
  aiInlineGetSettings: vi.fn(),
  aiInlineSetSettings: vi.fn(),
  aiInlineListOllamaModels: vi.fn(),
  aiInlineTestConnection: vi.fn()
}))
vi.mock('../../../../generated/bindings', () => ({ commands }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { AIInlineSettings } from './ai-inline-section'

const openai: InlineAiSettings = {
  enabled: true,
  provider: 'openai',
  model: 'gpt-4.1',
  apiKey: MASKED,
  baseUrl: ''
}

describe('AIInlineSettings', () => {
  beforeEach(() => {
    commands.aiInlineGetSettings.mockResolvedValue(openai)
    commands.aiInlineListOllamaModels.mockResolvedValue(['llama3.2'])
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('shows the stored key masked and sends a typed key to Rust, keeping only the mask', async () => {
    commands.aiInlineSetSettings.mockResolvedValue(openai)
    render(<AIInlineSettings />)
    const input = await screen.findByPlaceholderText('Enter OpenAI API key')
    expect((input as HTMLInputElement).value).toBe(MASKED)

    fireEvent.change(input, { target: { value: 'sk-typed' } })
    fireEvent.blur(input)

    await waitFor(() =>
      expect(commands.aiInlineSetSettings).toHaveBeenCalledWith({ apiKey: 'sk-typed' })
    )
    await waitFor(() => expect((input as HTMLInputElement).value).toBe(MASKED))
  })

  it('tests the connection through Rust and names the provider, not a port', async () => {
    commands.aiInlineTestConnection.mockResolvedValue({ ok: true, detail: null })
    render(<AIInlineSettings />)
    await userEvent.click(await screen.findByRole('button', { name: 'Test' }))

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Connected to OpenAI'))
    expect(screen.getByText('Connected')).toBeTruthy()
  })

  it('shows the reason Rust gives when the provider refuses', async () => {
    const detail = 'Your OpenAI API key was rejected. Check it in Settings → AI.'
    commands.aiInlineTestConnection.mockResolvedValue({ ok: false, detail })
    render(<AIInlineSettings />)
    await userEvent.click(await screen.findByRole('button', { name: 'Test' }))

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(detail))
    expect(screen.getByText('Not connected')).toBeTruthy()
  })

  it('reports a locked keychain on load instead of showing the defaults as saved', async () => {
    const message = "Memry can't reach your system keychain"
    commands.aiInlineGetSettings.mockRejectedValue({
      kind: 'locked',
      code: 'secure_store_locked',
      message
    })
    render(<AIInlineSettings />)

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(message))
  })

  it('probes Ollama on open and shows it connected when it answers', async () => {
    commands.aiInlineGetSettings.mockResolvedValue({
      ...openai,
      provider: 'ollama',
      apiKey: '',
      baseUrl: 'http://localhost:11434/v1'
    })
    render(<AIInlineSettings />)

    expect(await screen.findByText('Connected')).toBeTruthy()
    expect(commands.aiInlineListOllamaModels).toHaveBeenCalled()
  })
})
