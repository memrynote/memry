import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import type { InlineAiSettings } from '../../../../generated/bindings'

const MASKED = '\u2022'.repeat(8)

const commands = vi.hoisted(() => ({
  aiInlineGetSettings: vi.fn(),
  aiInlineSetSettings: vi.fn(),
  aiInlineListModels: vi.fn(),
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
    commands.aiInlineListModels.mockResolvedValue(['llama3.2'])
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

  it('does nothing when the screen closes before the settings arrive', async () => {
    let fail: (error: unknown) => void = () => {}
    commands.aiInlineGetSettings.mockReturnValue(
      new Promise((_, reject) => {
        fail = reject
      })
    )
    const first = render(<AIInlineSettings />)
    first.unmount()
    fail({ kind: 'locked', code: 'secure_store_locked', message: 'locked' })

    let answer: (settings: InlineAiSettings) => void = () => {}
    commands.aiInlineGetSettings.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve
      })
    )
    const second = render(<AIInlineSettings />)
    second.unmount()
    answer({ ...openai, provider: 'ollama', apiKey: '', baseUrl: 'http://localhost:11434/v1' })

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(commands.aiInlineGetSettings).toHaveBeenCalledTimes(2)
    expect(toast.error).not.toHaveBeenCalled()
    // One catalogue probe per mount (the defaults are Ollama); a load that went on after the
    // unmount would probe a third time.
    expect(commands.aiInlineListModels).toHaveBeenCalledTimes(2)
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
    expect(commands.aiInlineListModels).toHaveBeenCalled()
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
        model: 'claude-sonnet-5-5',
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
    commands.aiInlineListModels.mockRejectedValue({ kind: 'unreachable', message: 'down' })
    render(<AIInlineSettings />)

    expect(await screen.findByText('Not connected')).toBeTruthy()
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('lists a custom endpoint models, takes a typed model and tests without an API key', async () => {
    const custom: InlineAiSettings = {
      enabled: true,
      provider: 'custom',
      model: '',
      apiKey: '',
      baseUrl: 'https://openrouter.ai/api/v1'
    }
    commands.aiInlineGetSettings.mockResolvedValue(custom)
    commands.aiInlineListModels.mockResolvedValue(['openai/gpt-5'])
    commands.aiInlineSetSettings.mockImplementation(async (updates: Partial<InlineAiSettings>) => ({
      ...custom,
      ...updates
    }))
    commands.aiInlineTestConnection.mockResolvedValue({ ok: true, detail: null })
    render(<AIInlineSettings />)

    const url = await screen.findByDisplayValue('https://openrouter.ai/api/v1')
    expect(screen.getByPlaceholderText('API key (optional)')).toBeTruthy()
    await waitFor(() =>
      expect(document.querySelector('datalist option[value="openai/gpt-5"]')).not.toBeNull()
    )

    const model = screen.getByRole('combobox', { name: 'Model' })
    fireEvent.change(model, { target: { value: ' anthropic/claude-sonnet-4 ' } })
    fireEvent.blur(model)
    await waitFor(() =>
      expect(commands.aiInlineSetSettings).toHaveBeenCalledWith({
        model: 'anthropic/claude-sonnet-4'
      })
    )

    // A new URL is a new endpoint: its catalogue is asked again.
    fireEvent.change(url, { target: { value: 'https://llm.example/v1' } })
    fireEvent.blur(url)
    await waitFor(() => expect(commands.aiInlineListModels).toHaveBeenCalledTimes(2))

    await userEvent.click(screen.getByRole('button', { name: 'Test' }))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Connected to llm.example'))
  })

  it('shows the key state of the selected provider, as Rust answers it (#4451)', async () => {
    commands.aiInlineSetSettings.mockImplementation(async (updates: Partial<InlineAiSettings>) => ({
      ...openai,
      ...updates,
      apiKey: updates.provider === 'anthropic' ? '' : MASKED
    }))
    render(<AIInlineSettings />)
    expect(await screen.findByPlaceholderText('Enter OpenAI API key')).toHaveProperty(
      'value',
      MASKED
    )

    await userEvent.click(screen.getByRole('button', { name: 'Anthropic' }))
    const anthropic = await screen.findByPlaceholderText('Enter Anthropic API key')
    expect(anthropic).toHaveProperty('value', '')
    expect(screen.getByRole('button', { name: 'Test' })).toHaveProperty('disabled', true)
  })

  it('holds the custom key field until the endpoint URL parses', async () => {
    const custom: InlineAiSettings = {
      enabled: true,
      provider: 'custom',
      model: '',
      apiKey: '',
      baseUrl: ''
    }
    commands.aiInlineGetSettings.mockResolvedValue(custom)
    commands.aiInlineListModels.mockResolvedValue([])
    render(<AIInlineSettings />)

    const key = await screen.findByPlaceholderText('API key (optional)')
    expect(key).toHaveProperty('disabled', true)
    const url = screen.getByPlaceholderText('https://openrouter.ai/api/v1')
    fireEvent.change(url, { target: { value: 'not a url' } })
    expect(key).toHaveProperty('disabled', true)
    fireEvent.change(url, { target: { value: 'https://llm.example/v1' } })
    expect(key).toHaveProperty('disabled', false)
  })
  describe('on a WebView without URL.parse (WebKit before Safari 18)', () => {
    const parse = URL.parse
    beforeEach(() => {
      Object.defineProperty(URL, 'parse', { value: undefined, configurable: true })
    })
    afterEach(() => {
      Object.defineProperty(URL, 'parse', { value: parse, configurable: true })
    })

    it('renders a custom endpoint and names its host after a test', async () => {
      commands.aiInlineGetSettings.mockResolvedValue({
        enabled: true,
        provider: 'custom',
        model: '',
        apiKey: '',
        baseUrl: 'https://llm.example/v1'
      })
      commands.aiInlineTestConnection.mockResolvedValue({ ok: true, detail: null })
      render(<AIInlineSettings />)

      const key = await screen.findByPlaceholderText('API key (optional)')
      expect(key).toHaveProperty('disabled', false)
      await userEvent.click(screen.getByRole('button', { name: 'Test' }))
      await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Connected to llm.example'))
    })
  })

  it('holds the custom key field while the URL carries a user name, as Rust refuses it', async () => {
    commands.aiInlineGetSettings.mockResolvedValue({
      enabled: true,
      provider: 'custom',
      model: '',
      apiKey: '',
      baseUrl: 'https://user:pw@llm.example/v1'
    })
    commands.aiInlineListModels.mockResolvedValue([])
    render(<AIInlineSettings />)

    expect(await screen.findByPlaceholderText('API key (optional)')).toHaveProperty(
      'disabled',
      true
    )
  })

  it('sends an unsaved endpoint URL with the key typed for it', async () => {
    const custom: InlineAiSettings = {
      enabled: true,
      provider: 'custom',
      model: '',
      apiKey: '',
      baseUrl: ''
    }
    commands.aiInlineGetSettings.mockResolvedValue(custom)
    commands.aiInlineListModels.mockResolvedValue([])
    commands.aiInlineSetSettings.mockImplementation(async (updates: Partial<InlineAiSettings>) => ({
      ...custom,
      ...updates,
      apiKey: updates.apiKey ? MASKED : ''
    }))
    render(<AIInlineSettings />)

    const key = await screen.findByPlaceholderText('API key (optional)')
    const url = screen.getByPlaceholderText('https://openrouter.ai/api/v1')
    fireEvent.change(url, { target: { value: 'https://llm.example/v1' } })
    fireEvent.change(key, { target: { value: 'sk-typed' } })
    fireEvent.blur(key)

    await waitFor(() =>
      expect(commands.aiInlineSetSettings).toHaveBeenCalledWith({
        apiKey: 'sk-typed',
        baseUrl: 'https://llm.example/v1'
      })
    )
    expect(commands.aiInlineSetSettings).toHaveBeenCalledTimes(1)
    expect(url).toHaveProperty('value', 'https://llm.example/v1')
  })

  it('sends an unsaved key with the endpoint URL it was typed for', async () => {
    const custom: InlineAiSettings = {
      enabled: true,
      provider: 'custom',
      model: '',
      apiKey: '',
      baseUrl: 'https://old.example/v1'
    }
    commands.aiInlineGetSettings.mockResolvedValue(custom)
    commands.aiInlineListModels.mockResolvedValue([])
    commands.aiInlineSetSettings.mockImplementation(async (updates: Partial<InlineAiSettings>) => ({
      ...custom,
      ...updates,
      apiKey: updates.apiKey ? MASKED : ''
    }))
    render(<AIInlineSettings />)

    const key = await screen.findByPlaceholderText('API key (optional)')
    const url = screen.getByPlaceholderText('https://openrouter.ai/api/v1')
    fireEvent.change(key, { target: { value: 'sk-typed' } })
    fireEvent.change(url, { target: { value: 'https://llm.example/v1' } })
    fireEvent.blur(url)

    await waitFor(() =>
      expect(commands.aiInlineSetSettings).toHaveBeenCalledWith({
        baseUrl: 'https://llm.example/v1',
        apiKey: 'sk-typed'
      })
    )
  })
})
