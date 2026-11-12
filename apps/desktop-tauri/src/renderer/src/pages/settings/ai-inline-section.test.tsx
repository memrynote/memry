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
// Radix Select needs pointer capture that jsdom lacks; a flat stand-in renders every item
// as a button that picks its value.
vi.mock('@/components/ui/select', async () => {
  const React = await import('react')
  const Pick = React.createContext<((value: string) => void) | undefined>(undefined)
  return {
    Select: ({
      children,
      onValueChange
    }: {
      children: React.ReactNode
      onValueChange?: (value: string) => void
    }) => <Pick.Provider value={onValueChange}>{children}</Pick.Provider>,
    SelectTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    SelectValue: () => null,
    SelectContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    SelectItem: ({ children, value }: { children: React.ReactNode; value: string }) => {
      const pick = React.useContext(Pick)
      return (
        <button type="button" onClick={() => pick?.(value)}>
          {children}
        </button>
      )
    }
  }
})

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

  it('switches provider with its default model and disables inline AI', async () => {
    commands.aiInlineSetSettings.mockImplementation(async (updates: Partial<InlineAiSettings>) => ({
      ...openai,
      ...updates
    }))
    render(<AIInlineSettings />)
    await userEvent.click(await screen.findByRole('button', { name: 'Anthropic' }))
    await waitFor(() =>
      expect(commands.aiInlineSetSettings).toHaveBeenCalledWith({
        provider: 'anthropic',
        model: 'claude-sonnet-5',
        baseUrl: ''
      })
    )

    await userEvent.click(screen.getByRole('switch'))
    await waitFor(() =>
      expect(commands.aiInlineSetSettings).toHaveBeenCalledWith({ enabled: false })
    )
    expect(toast.success).toHaveBeenCalledWith('Inline AI editing disabled')
  })

  it('shows Ollama as not connected when it does not answer on open', async () => {
    commands.aiInlineGetSettings.mockResolvedValue({
      ...openai,
      provider: 'ollama',
      apiKey: '',
      baseUrl: 'http://localhost:11434/v1'
    })
    commands.aiInlineListOllamaModels.mockRejectedValue({ kind: 'unreachable', message: 'down' })
    render(<AIInlineSettings />)

    expect(await screen.findByText('Not connected')).toBeTruthy()
    expect(toast.success).not.toHaveBeenCalled()
  })
})
