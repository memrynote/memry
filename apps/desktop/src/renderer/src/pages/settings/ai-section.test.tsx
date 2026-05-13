import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { createMockApi } from '@tests/setup-dom'
import { AISettings } from './ai-section'

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn()
  }
}))

vi.mock('./ai-inline-section', () => ({
  AIInlineSettings: () => <div>Inline AI panel</div>
}))

vi.mock('./agent-providers-section', () => ({
  AgentProvidersSection: () => <div data-testid="agent-providers-panel" />
}))

vi.mock('./agent-mcp-section', () => ({
  AgentMcpSection: () => <div data-testid="agent-mcp-panel" />
}))

type EmbeddingProgressEvent = {
  phase: string
  progress?: number
  current?: number
  total?: number
  status?: string
}

type SettingsApi = ReturnType<typeof createMockApi> & {
  onEmbeddingProgress: (callback: (event: EmbeddingProgressEvent) => void) => () => void
  onVoiceModelProgress: (callback: (event: EmbeddingProgressEvent) => void) => () => void
}

describe('AISettings', () => {
  let api: SettingsApi
  let embeddingCallbacks: Array<(event: EmbeddingProgressEvent) => void>
  let voiceCallbacks: Array<(event: EmbeddingProgressEvent) => void>

  beforeEach(() => {
    vi.clearAllMocks()
    embeddingCallbacks = []
    voiceCallbacks = []

    if (!HTMLElement.prototype.hasPointerCapture) {
      HTMLElement.prototype.hasPointerCapture = vi.fn(() => false)
    }
    if (!HTMLElement.prototype.setPointerCapture) {
      HTMLElement.prototype.setPointerCapture = vi.fn()
    }
    if (!HTMLElement.prototype.releasePointerCapture) {
      HTMLElement.prototype.releasePointerCapture = vi.fn()
    }
    if (!HTMLElement.prototype.scrollIntoView) {
      HTMLElement.prototype.scrollIntoView = vi.fn()
    }

    api = createMockApi() as SettingsApi
    api.settings.getAISettings = vi.fn().mockResolvedValue({ enabled: true })
    api.settings.setAISettings = vi.fn().mockResolvedValue({ success: true })
    api.settings.getAIModelStatus = vi
      .fn()
      .mockResolvedValueOnce({
        name: 'MiniLM',
        dimension: 384,
        loaded: false,
        loading: false,
        error: null,
        embeddingCount: 12
      })
      .mockResolvedValue({
        name: 'MiniLM',
        dimension: 384,
        loaded: true,
        loading: false,
        error: null,
        embeddingCount: 24
      })
    api.settings.loadAIModel = vi.fn().mockResolvedValue({ success: true, message: 'ready' })
    api.settings.reindexEmbeddings = vi.fn().mockResolvedValue({
      success: true,
      computed: 3,
      skipped: 1
    })
    api.settings.getVoiceTranscriptionSettings = vi.fn().mockResolvedValue({ provider: 'local' })
    api.settings.setVoiceTranscriptionSettings = vi.fn().mockResolvedValue({ success: true })
    api.settings.getVoiceModelStatus = vi.fn().mockResolvedValue({
      name: 'Whisper Small',
      downloaded: false,
      loaded: false,
      loading: false,
      error: null
    })
    api.settings.downloadVoiceModel = vi.fn().mockResolvedValue({ success: true })
    api.settings.getVoiceTranscriptionOpenAIKeyStatus = vi.fn().mockResolvedValue({
      hasApiKey: false
    })
    api.settings.setVoiceTranscriptionOpenAIKey = vi.fn().mockResolvedValue({ success: true })
    api.onEmbeddingProgress = vi.fn((callback) => {
      embeddingCallbacks.push(callback)
      return () => {}
    })
    api.onVoiceModelProgress = vi.fn((callback) => {
      voiceCallbacks.push(callback)
      return () => {}
    })
    ;(window as Window & { api: unknown }).api = api
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('loads settings, toggles AI, loads the embedding model, and rebuilds embeddings', async () => {
    api.settings.getAISettings = vi.fn().mockResolvedValue({ enabled: false })
    render(<AISettings />)

    expect(screen.getByText('Loading settings...')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText('Enable AI Features')).toBeInTheDocument())
    expect(screen.queryByText('Local Embedding Model')).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('switch'))
    expect(api.settings.setAISettings).toHaveBeenCalledWith({ enabled: true })
    expect(toast.success).toHaveBeenCalledWith('AI features enabled')
    await waitFor(() => expect(screen.getByText('Local Embedding Model')).toBeInTheDocument())

    await userEvent.click(screen.getByRole('button', { name: 'Download & Load Model' }))
    expect(api.settings.loadAIModel).toHaveBeenCalled()
    await waitFor(() => expect(screen.getByText('Loaded')).toBeInTheDocument())

    await userEvent.click(screen.getByRole('button', { name: 'Rebuild' }))
    expect(api.settings.reindexEmbeddings).toHaveBeenCalled()
    expect(toast.success).toHaveBeenCalledWith('Embeddings reindexed: 3 computed, 1 skipped')
  })

  it('keeps agent provider and MCP controls collapsed inside AI settings', async () => {
    render(<AISettings />)

    await waitFor(() => expect(screen.getByText('Agent Providers')).toBeInTheDocument())
    expect(screen.queryByTestId('agent-providers-panel')).not.toBeInTheDocument()
    expect(screen.queryByTestId('agent-mcp-panel')).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /Agent Providers/ }))
    expect(screen.getByTestId('agent-providers-panel')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /Agent MCP/ }))
    expect(screen.getByTestId('agent-mcp-panel')).toBeInTheDocument()
  })

  it('opens the matching advanced panel for legacy agent settings sections', async () => {
    render(<AISettings initialOpenPanel="agent-mcp" />)

    await waitFor(() => expect(screen.getByTestId('agent-mcp-panel')).toBeInTheDocument())
    expect(screen.queryByTestId('agent-providers-panel')).not.toBeInTheDocument()
  })

  it('highlights the voice local model row when focused from voice capture', async () => {
    render(<AISettings focusTarget="voice-local-model" focusRequestId={1} />)

    await waitFor(() =>
      expect(screen.getByTestId('voice-local-model-row')).toHaveClass('settings-focus-heartbeat')
    )
  })

  it('handles voice OpenAI key saving, model download, and progress events', async () => {
    api.settings.getVoiceTranscriptionSettings = vi.fn().mockResolvedValue({ provider: 'openai' })
    api.settings.getVoiceTranscriptionOpenAIKeyStatus = vi.fn().mockResolvedValue({
      hasApiKey: true
    })
    api.settings.getVoiceModelStatus = vi
      .fn()
      .mockResolvedValueOnce({
        name: 'Whisper Small',
        downloaded: false,
        loaded: false,
        loading: false,
        error: null
      })
      .mockResolvedValue({
        name: 'Whisper Small',
        downloaded: true,
        loaded: true,
        loading: false,
        error: null
      })

    render(<AISettings />)

    await waitFor(() =>
      expect(screen.getByPlaceholderText('Replace saved OpenAI key')).toBeInTheDocument()
    )

    await userEvent.type(screen.getByPlaceholderText('Replace saved OpenAI key'), 'sk-test')
    await userEvent.click(screen.getByRole('button', { name: 'Save Key' }))
    expect(api.settings.setVoiceTranscriptionOpenAIKey).toHaveBeenCalledWith('sk-test')
    expect(toast.success).toHaveBeenCalledWith('OpenAI key saved')

    await act(async () => {
      voiceCallbacks[0]({ phase: 'downloading', progress: 42, status: 'Fetching model' })
    })
    expect(screen.getByText('Fetching model')).toBeInTheDocument()
    expect(screen.getByText('42%')).toBeInTheDocument()

    await act(async () => {
      voiceCallbacks[0]({ phase: 'ready' })
    })
    await waitFor(() => expect(api.settings.getVoiceModelStatus).toHaveBeenCalledTimes(2))
  })

  it('saves the voice memo naming mode', async () => {
    api.settings.getVoiceTranscriptionSettings = vi.fn().mockResolvedValue({
      provider: 'local',
      memoNameMode: 'timestamp'
    })

    render(<AISettings />)

    await waitFor(() => expect(screen.getByText('Timestamp')).toBeInTheDocument())

    const selects = screen.getAllByRole('combobox')
    await userEvent.click(selects[1])
    await userEvent.click(await screen.findByRole('option', { name: 'Transcript title' }))

    expect(api.settings.setVoiceTranscriptionSettings).toHaveBeenCalledWith({
      memoNameMode: 'transcript'
    })
  })

  it('surfaces progress and errors from embedding callbacks', async () => {
    render(<AISettings />)

    await waitFor(() => expect(screen.getByText('Embedding Index')).toBeInTheDocument())

    await act(async () => {
      embeddingCallbacks[0]({ phase: 'downloading', progress: 30 })
    })

    expect(screen.getByText('Downloading model...')).toBeInTheDocument()
    expect(screen.getByText('30%')).toBeInTheDocument()

    await act(async () => {
      embeddingCallbacks[0]({ phase: 'error', status: 'model failed' })
    })

    expect(screen.getByText('model failed')).toBeInTheDocument()
  })

  it('surfaces failed setting, model, voice, key, and reindex mutations', async () => {
    api.settings.getAISettings = vi.fn().mockResolvedValue({ enabled: true })
    api.settings.getAIModelStatus = vi.fn().mockResolvedValue({
      name: 'MiniLM',
      dimension: 384,
      loaded: false,
      loading: false,
      error: 'previous embedding error',
      embeddingCount: 0
    })
    api.settings.setAISettings = vi
      .fn()
      .mockResolvedValue({ success: false, error: 'toggle failed' })
    api.settings.loadAIModel = vi.fn().mockResolvedValue({ success: false, error: 'load failed' })
    api.settings.reindexEmbeddings = vi
      .fn()
      .mockResolvedValueOnce({ success: false, error: 'reindex failed' })
      .mockRejectedValueOnce(new Error('reindex exploded'))
    api.settings.downloadVoiceModel = vi.fn().mockResolvedValue({
      success: false,
      error: 'voice download failed'
    })
    api.settings.getVoiceTranscriptionSettings = vi.fn().mockResolvedValue({ provider: 'openai' })
    api.settings.getVoiceTranscriptionOpenAIKeyStatus = vi
      .fn()
      .mockResolvedValue({ hasApiKey: true })
    api.settings.setVoiceTranscriptionOpenAIKey = vi
      .fn()
      .mockResolvedValueOnce({ success: false, error: 'key failed' })
      .mockRejectedValueOnce(new Error('key exploded'))

    render(<AISettings />)
    await waitFor(() => expect(screen.getByText('previous embedding error')).toBeInTheDocument())

    await userEvent.click(screen.getByRole('switch'))
    expect(toast.error).toHaveBeenCalledWith('toggle failed')

    await userEvent.click(screen.getByRole('button', { name: 'Download & Load Model' }))
    expect(toast.error).toHaveBeenCalledWith('load failed')

    await userEvent.click(screen.getByRole('button', { name: 'Download Whisper Small' }))
    expect(toast.error).toHaveBeenCalledWith('voice download failed')

    const keyInput = screen.getByPlaceholderText('Replace saved OpenAI key')
    await userEvent.type(keyInput, 'sk-fail')
    await userEvent.click(screen.getByRole('button', { name: 'Save Key' }))
    expect(toast.error).toHaveBeenCalledWith('key failed')

    await userEvent.clear(keyInput)
    await userEvent.type(keyInput, 'sk-throw')
    await userEvent.click(screen.getByRole('button', { name: 'Save Key' }))
    expect(toast.error).toHaveBeenCalledWith('key exploded')

    await waitFor(() => expect(screen.getByRole('button', { name: 'Rebuild' })).toBeDisabled())
  })

  it('handles reindex progress completion and voice/embedding progress error fallbacks', async () => {
    api.settings.getAISettings = vi.fn().mockResolvedValue({ enabled: true })
    api.settings.getAIModelStatus = vi.fn().mockResolvedValue({
      name: 'MiniLM',
      dimension: 384,
      loaded: true,
      loading: false,
      error: null,
      embeddingCount: 1
    })
    api.settings.getVoiceModelStatus = vi.fn().mockResolvedValue({
      name: 'Whisper Small',
      downloaded: true,
      loaded: false,
      loading: false,
      error: null
    })
    let resolveReindex!: (value: { success: boolean; computed: number; skipped: number }) => void
    api.settings.reindexEmbeddings = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveReindex = resolve
        })
    )

    render(<AISettings />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Rebuild' })).toBeEnabled())

    await userEvent.click(screen.getByRole('button', { name: 'Rebuild' }))
    await act(async () => {
      embeddingCallbacks[0]({ phase: 'embedding', current: 2, total: 5 })
    })
    expect(screen.getByText('2 / 5')).toBeInTheDocument()

    vi.useFakeTimers()
    await act(async () => {
      embeddingCallbacks[0]({ phase: 'complete', current: 5, total: 5 })
      vi.advanceTimersByTime(1000)
    })
    await waitFor(() => expect(api.settings.getAIModelStatus).toHaveBeenCalledTimes(2))

    await act(async () => {
      embeddingCallbacks[0]({ phase: 'ready' })
    })
    await waitFor(() => expect(api.settings.getAIModelStatus).toHaveBeenCalledTimes(3))

    await act(async () => {
      voiceCallbacks[0]({ phase: 'error' })
    })
    expect(screen.getByText('Unknown error')).toBeInTheDocument()

    await act(async () => {
      resolveReindex({ success: true, computed: 5, skipped: 0 })
    })

    vi.useRealTimers()
  })
})
