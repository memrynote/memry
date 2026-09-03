import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { toast } from 'sonner'

const mockUseAgentOptional = vi.hoisted(() => vi.fn())
const mockUseActiveTab = vi.hoisted(() => vi.fn())
const mockPrepareVoiceMemoAudio = vi.hoisted(() => vi.fn())

vi.mock('../agent-context', () => ({
  useAgentOptional: mockUseAgentOptional
}))

vi.mock('@/contexts/tabs', () => ({
  // The transcript keeps its scroll position in tab state; these tests render
  // it outside a tab, where that degrades to no persistence at all.
  useTabActionsOptional: () => null,
  useActiveTab: mockUseActiveTab
}))

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() }
}))

vi.mock('@/lib/voice-memo-audio', () => ({
  prepareVoiceMemoAudio: mockPrepareVoiceMemoAudio
}))

import { SettingsModalProvider } from '@/contexts/settings-modal-context'
import { Composer } from '../composer'

class MockMediaRecorder {
  static isTypeSupported = vi.fn(() => true)

  state: 'inactive' | 'recording' = 'inactive'
  ondataavailable: ((event: { data: Blob }) => void) | null = null
  onstop: (() => void) | null = null
  onerror: ((event: unknown) => void) | null = null

  constructor(
    public stream: MediaStream,
    public options: MediaRecorderOptions
  ) {}

  start(): void {
    this.state = 'recording'
  }

  stop(): void {
    this.state = 'inactive'
    queueMicrotask(() => {
      this.ondataavailable?.({ data: new Blob(['voice'], { type: 'audio/webm' }) })
      this.onstop?.()
    })
  }
}

const mockSendTurn = vi.fn()
const mockCancelTurn = vi.fn()
const mockCreateConversation = vi.fn()
const mockSearchQuery = vi.fn()
const mockCalendarListEvents = vi.fn()
const mockGetProviderStatus = vi.fn()
const mockConnectProvider = vi.fn()
const mockGetUserMedia = vi.fn()
const readyBackendStatuses = {
  claude_cli: { backend: 'claude_cli', available: true },
  codex_cli: { backend: 'codex_cli', available: true },
  local_openai_compatible: { backend: 'local_openai_compatible', available: true }
}

function renderComposer(conversationId: string | null): ReturnType<typeof render> {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <SettingsModalProvider>
        <Composer conversationId={conversationId} sourceWindowId="window-1" />
      </SettingsModalProvider>
    </QueryClientProvider>
  )
}

async function setPromptText(text: string): Promise<HTMLElement> {
  const textbox = screen.getByRole('textbox')
  await userEvent.click(textbox)
  await userEvent.keyboard('{Control>}a{/Control}{Backspace}')
  if (text) {
    await userEvent.type(textbox, text)
  }
  return textbox
}

async function submitPrompt(): Promise<void> {
  await act(async () => {
    await userEvent.keyboard('{Enter}')
    await Promise.resolve()
  })
}

async function openSettingsMenu(): Promise<void> {
  // The composer schedules an editor focus on mount; let it land before the
  // menu opens, or it fires mid-interaction and Radix closes the submenu.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30))
  })
  fireEvent.pointerDown(screen.getByTestId('agent-model-trigger'))
  await screen.findByRole('menuitem', { name: /web search/i })
  // Opening also kicks off the model/local-provider loads; settle them before
  // touching submenus so data landing mid-interaction can't detach content.
  await act(async () => {})
}

// Radix SubTrigger opens on click when the event carries no mouse pointerType,
// which is exactly what jsdom produces (same trick as dropdown-menu.test.tsx).
function openSubmenu(trigger: HTMLElement): void {
  fireEvent.click(trigger)
}

async function openModelSubmenu(): Promise<void> {
  await openSettingsMenu()
  openSubmenu(screen.getByTestId('agent-model-submenu-trigger'))
  await screen.findByPlaceholderText('Search models…')
}

function closeMenus(): void {
  fireEvent.keyDown(document, { key: 'Escape' })
  fireEvent.keyDown(document, { key: 'Escape' })
}

describe('Composer', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.mocked(toast.error).mockReset()
    mockGetUserMedia.mockReset()
    mockGetUserMedia.mockResolvedValue({ getTracks: () => [{ stop: vi.fn() }] })
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: mockGetUserMedia }
    })
    Object.defineProperty(globalThis, 'MediaRecorder', {
      configurable: true,
      value: MockMediaRecorder
    })
    mockPrepareVoiceMemoAudio.mockReset()
    mockPrepareVoiceMemoAudio.mockResolvedValue({
      data: new ArrayBuffer(8),
      duration: 1.5,
      format: 'wav',
      waveform: []
    })
    vi.mocked(window.api.settings.getVoiceRecordingReadiness).mockResolvedValue({
      ready: true,
      provider: 'local'
    })
    vi.mocked(window.api.inbox.transcribeAudio).mockReset()
    mockSendTurn.mockReset()
    mockCancelTurn.mockReset()
    mockCreateConversation.mockReset()
    mockCreateConversation.mockResolvedValue({ id: 'conversation-2' })
    mockSearchQuery.mockReset()
    mockSearchQuery.mockResolvedValue({
      groups: [],
      totalCount: 0,
      queryTimeMs: 0
    })
    mockCalendarListEvents.mockReset()
    mockCalendarListEvents.mockResolvedValue({ events: [] })
    mockUseActiveTab.mockReturnValue(null)
    mockUseAgentOptional.mockReturnValue({
      state: {
        inFlight: {},
        conversations: {},
        backendStatuses: readyBackendStatuses
      },
      createConversation: mockCreateConversation,
      sendTurn: mockSendTurn,
      cancelTurn: mockCancelTurn
    })
    vi.mocked(window.api.search.query).mockImplementation(mockSearchQuery)
    mockGetProviderStatus.mockReset()
    mockGetProviderStatus.mockResolvedValue({ provider: 'google', connected: true })
    mockConnectProvider.mockReset()
    mockConnectProvider.mockResolvedValue({ success: true })
    Object.assign(window.api, {
      calendar: {
        ...((window.api as unknown as { calendar?: Record<string, unknown> }).calendar ?? {}),
        listEvents: mockCalendarListEvents,
        getProviderStatus: mockGetProviderStatus,
        connectProvider: mockConnectProvider
      }
    })
    vi.mocked(window.api.agent.listBackendModels).mockImplementation(async ({ backend }) => ({
      backend,
      supportsCustomModel: true,
      models:
        backend === 'claude_cli'
          ? [
              { id: 'sonnet', label: 'Sonnet' },
              { id: 'haiku', label: 'Haiku' },
              { id: 'opus', label: 'Opus' }
            ]
          : [
              { id: 'gpt-5.4', label: 'GPT-5.4' },
              { id: 'gpt-5.5', label: 'GPT-5.5' },
              { id: 'gpt-5.4-mini', label: 'GPT-5.4 Mini' }
            ]
    }))
    vi.mocked(window.api.agent.getPreferences).mockResolvedValue({
      accessMode: 'vault_only',
      toolApprovalMode: 'always_accept'
    })
    vi.mocked(window.api.agent.getLocalProviderSettings).mockResolvedValue({
      preset: 'ollama',
      baseUrl: 'http://localhost:11434/v1',
      model: '',
      apiKeyConfigured: false,
      allowNonLoopback: false
    })
    vi.mocked(window.api.agent.listLocalModels).mockResolvedValue({ models: [] })
  })

  it('submits on Enter', async () => {
    renderComposer('conversation-1')

    await setPromptText('hello')
    await submitPrompt()

    expect(mockSendTurn).toHaveBeenCalledWith({
      conversationId: 'conversation-1',
      sourceWindowId: 'window-1',
      text: 'hello',
      attachments: [],
      backendOptions: { backend: 'claude_cli', claudeEffort: 'xhigh', model: 'opus' }
    })
  })

  it('submits from pointer down on the send button', async () => {
    renderComposer('conversation-1')

    await setPromptText('hello')
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() => {
      expect(mockSendTurn).toHaveBeenCalledWith({
        conversationId: 'conversation-1',
        sourceWindowId: 'window-1',
        text: 'hello',
        attachments: [],
        backendOptions: { backend: 'claude_cli', claudeEffort: 'xhigh', model: 'opus' }
      })
    })
  })

  it('renders the agent composer surface', () => {
    const { container } = renderComposer('conversation-1')

    expect(container.firstElementChild).not.toHaveClass('border-t')
    expect(screen.getByRole('textbox')).toHaveClass('!min-h-9')
    expect(screen.getByTestId('agent-model-trigger')).toHaveTextContent('Opus · Extra High')
    expect(screen.getByRole('button', { name: 'Mention a note, task, or event' })).toHaveClass(
      'size-7'
    )
    // The send button only appears once the prompt has text; the mic owns the
    // slot at rest.
    expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Start voice dictation' })).toBeInTheDocument()
    expect(screen.queryByText('Agent')).not.toBeInTheDocument()
  })

  it('offers the connected-tools tray only while Google Calendar is unlinked', async () => {
    mockGetProviderStatus.mockResolvedValue({ provider: 'google', connected: false })
    renderComposer('conversation-1')

    const connectButton = await screen.findByRole('button', { name: 'Connect Google Calendar' })
    expect(screen.getByText('Connected tools')).toBeInTheDocument()

    // Same hand-off as the calendar toolbar: the icon opens the consent dialog
    // rather than firing OAuth straight from the tray.
    fireEvent.click(connectButton)

    const dialog = await screen.findByTestId('google-calendar-connect-prompt')
    expect(mockConnectProvider).not.toHaveBeenCalled()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Continue with Google' }))

    await waitFor(() => expect(mockConnectProvider).toHaveBeenCalledWith({ provider: 'google' }))
  })

  it('hides the connected-tools tray once Google Calendar is linked', async () => {
    renderComposer('conversation-1')

    await waitFor(() => expect(mockGetProviderStatus).toHaveBeenCalled())
    expect(screen.queryByText('Connected tools')).not.toBeInTheDocument()
  })

  it('offers voice dictation from an idle mic button', () => {
    renderComposer('conversation-1')

    const mic = screen.getByRole('button', { name: 'Start voice dictation' })
    expect(mic).toBeEnabled()
    expect(mic).toHaveClass('size-7')
    expect(mic).toHaveClass('text-muted-foreground')
    expect(mic).not.toHaveClass('text-destructive')
  })

  it('swaps the mic for send once the prompt has text, and back when cleared', async () => {
    renderComposer('conversation-1')

    expect(screen.getByRole('button', { name: 'Start voice dictation' })).toBeInTheDocument()

    await setPromptText('hello')

    expect(screen.queryByRole('button', { name: 'Start voice dictation' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled()

    await setPromptText('')

    expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Start voice dictation' })).toBeInTheDocument()
  })

  it('records, transcribes, and inserts the transcript into the prompt', async () => {
    let resolveTranscription: (value: { success: boolean; text: string }) => void = () => {}
    vi.mocked(window.api.inbox.transcribeAudio).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveTranscription = resolve
        })
    )
    renderComposer('conversation-1')

    await userEvent.click(screen.getByRole('button', { name: 'Start voice dictation' }))

    const recordingMic = await screen.findByRole('button', { name: 'Stop voice dictation' })
    expect(recordingMic).toHaveClass('size-7')
    expect(recordingMic).toHaveClass('text-destructive')

    await userEvent.click(recordingMic)

    const transcribingMic = await screen.findByRole('button', {
      name: 'Transcribing voice input'
    })
    expect(transcribingMic).toHaveClass('size-7')
    expect(window.api.inbox.transcribeAudio).toHaveBeenCalledWith({
      data: expect.any(ArrayBuffer),
      duration: 1.5,
      format: 'wav'
    })

    await act(async () => {
      resolveTranscription({ success: true, text: 'call the vet' })
      await Promise.resolve()
    })

    await waitFor(() => expect(screen.getByRole('textbox')).toHaveTextContent('call the vet'))
    // The transcript filled the prompt, so the slot now shows send.
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument()
  })

  it('returns to idle and surfaces the error when the microphone is blocked', async () => {
    mockGetUserMedia.mockRejectedValue(new DOMException('blocked', 'NotAllowedError'))
    renderComposer('conversation-1')

    await userEvent.click(screen.getByRole('button', { name: 'Start voice dictation' }))

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Microphone access denied'))
    expect(screen.getByRole('button', { name: 'Start voice dictation' })).toBeInTheDocument()
  })

  it('returns to idle and surfaces the error when transcription fails', async () => {
    vi.mocked(window.api.inbox.transcribeAudio).mockResolvedValue({
      success: false,
      text: '',
      error: 'Whisper is unavailable'
    })
    renderComposer('conversation-1')

    await userEvent.click(screen.getByRole('button', { name: 'Start voice dictation' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Stop voice dictation' }))

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Whisper is unavailable'))
    expect(await screen.findByRole('button', { name: 'Start voice dictation' })).toBeInTheDocument()
  })

  it('opens the composer settings menu from the model summary', async () => {
    renderComposer('conversation-1')

    const trigger = screen.getByTestId('agent-model-trigger')
    expect(trigger).not.toHaveClass('border')
    expect(trigger).toHaveClass('hover:bg-accent')
    expect(trigger).toHaveClass('rounded-md')
    expect(trigger).toHaveClass('data-[state=open]:bg-accent')

    await openSettingsMenu()

    expect(screen.getByRole('menuitem', { name: /web search/i })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: /include current note/i })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: /^access/i })).toHaveTextContent('Vault only')
    expect(screen.getByRole('menuitem', { name: /^effort/i })).toHaveTextContent('Extra High')
    expect(screen.getByTestId('agent-model-submenu-trigger')).toHaveTextContent('Opus')
    expect(screen.queryByText('Provider')).not.toBeInTheDocument()
  })

  it('passes selected access mode and web search intent with the prompt', async () => {
    renderComposer('conversation-1')

    await openSettingsMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: /web search/i }))
    openSubmenu(screen.getByRole('menuitem', { name: /^access/i }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Computer access' }))
    closeMenus()

    await waitFor(() =>
      expect(screen.queryByRole('menuitem', { name: /web search/i })).not.toBeInTheDocument()
    )

    await setPromptText('check the launch page')
    await submitPrompt()

    expect(mockSendTurn).toHaveBeenCalledWith({
      conversationId: 'conversation-1',
      sourceWindowId: 'window-1',
      text: 'check the launch page',
      attachments: [],
      backendOptions: { backend: 'claude_cli', claudeEffort: 'xhigh', model: 'opus' },
      permissions: { accessMode: 'computer_access', webSearchEnabled: true }
    })
  })

  it('shows Claude effort options in the effort submenu and updates the summary', async () => {
    renderComposer('conversation-1')

    await openSettingsMenu()
    openSubmenu(screen.getByRole('menuitem', { name: /^effort/i }))

    expect(
      await screen.findByRole('menuitem', { name: 'Extra High (default)' })
    ).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'Ultrathink' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('menuitem', { name: 'Low' }))
    closeMenus()

    await waitFor(() =>
      expect(screen.getByTestId('agent-model-trigger')).toHaveTextContent('Opus · Low')
    )
  })

  it('passes the selected Claude effort with the prompt', async () => {
    renderComposer('conversation-1')

    await openSettingsMenu()
    openSubmenu(screen.getByRole('menuitem', { name: /^effort/i }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Low' }))
    closeMenus()

    await setPromptText('quick answer')
    await submitPrompt()

    expect(mockSendTurn).toHaveBeenCalledWith({
      conversationId: 'conversation-1',
      sourceWindowId: 'window-1',
      text: 'quick answer',
      attachments: [],
      backendOptions: { backend: 'claude_cli', claudeEffort: 'low', model: 'opus' }
    })
  })

  it('persists the effort pick across composer instances', async () => {
    const first = renderComposer('conversation-1')

    await openSettingsMenu()
    openSubmenu(screen.getByRole('menuitem', { name: /^effort/i }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Low' }))
    closeMenus()
    first.unmount()

    renderComposer('conversation-1')

    expect(screen.getByTestId('agent-model-trigger')).toHaveTextContent('Opus · Low')
  })

  it('passes the selected Claude model with the prompt', async () => {
    renderComposer('conversation-1')

    await openModelSubmenu()
    expect(screen.queryByRole('menuitem', { name: 'Default' })).not.toBeInTheDocument()
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Sonnet' }))

    await setPromptText('deep answer')
    await submitPrompt()

    expect(mockSendTurn).toHaveBeenCalledWith({
      conversationId: 'conversation-1',
      sourceWindowId: 'window-1',
      text: 'deep answer',
      attachments: [],
      backendOptions: { backend: 'claude_cli', claudeEffort: 'xhigh', model: 'sonnet' }
    })
  })

  it('shows a setup row instead of models for an unavailable CLI provider', async () => {
    mockUseAgentOptional.mockReturnValue({
      state: {
        inFlight: {},
        conversations: {},
        backendStatuses: {
          ...readyBackendStatuses,
          codex_cli: {
            backend: 'codex_cli',
            available: false,
            reason: 'missing_binary',
            detail: 'Install Codex CLI.'
          }
        }
      },
      createConversation: mockCreateConversation,
      sendTurn: mockSendTurn,
      cancelTurn: mockCancelTurn
    })
    renderComposer('conversation-1')

    await openModelSubmenu()

    expect(await screen.findByRole('menuitem', { name: 'Sonnet' })).toBeInTheDocument()
    expect(screen.getByText('Codex')).toBeInTheDocument()
    expect(
      screen.getByRole('menuitem', { name: 'Not detected — set up in Settings…' })
    ).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'GPT-5.5' })).not.toBeInTheDocument()
  })

  it('names the real cause when the agent runtime, not the CLI, is unavailable', async () => {
    const agentUnavailable = {
      available: false,
      reason: 'agent_unavailable',
      detail: 'Agent runtime unavailable: Current master key does not match this vault'
    }
    mockUseAgentOptional.mockReturnValue({
      state: {
        inFlight: {},
        conversations: {},
        backendStatuses: {
          ...readyBackendStatuses,
          claude_cli: { backend: 'claude_cli', ...agentUnavailable },
          codex_cli: { backend: 'codex_cli', ...agentUnavailable }
        }
      },
      createConversation: mockCreateConversation,
      sendTurn: mockSendTurn,
      cancelTurn: mockCancelTurn
    })
    renderComposer('conversation-1')

    await openModelSubmenu()

    expect(
      await screen.findAllByRole('menuitem', {
        name: 'Agent unavailable — open Settings…'
      })
    ).toHaveLength(2)
    expect(
      screen.queryByRole('menuitem', { name: 'Not detected — set up in Settings…' })
    ).not.toBeInTheDocument()
  })

  it('passes Codex backend options when a Codex model is picked', async () => {
    renderComposer('conversation-1')

    await openModelSubmenu()
    fireEvent.click(await screen.findByRole('menuitem', { name: 'GPT-5.5' }))

    await setPromptText('create a task')
    await submitPrompt()

    expect(mockSendTurn).toHaveBeenCalledWith({
      conversationId: 'conversation-1',
      sourceWindowId: 'window-1',
      text: 'create a task',
      attachments: [],
      backendOptions: { backend: 'codex_cli', reasoningEffort: 'medium', model: 'gpt-5.5' }
    })
  })

  it('shows supported Codex reasoning options once a Codex model is selected', async () => {
    renderComposer('conversation-1')

    await openModelSubmenu()
    fireEvent.click(await screen.findByRole('menuitem', { name: 'GPT-5.5' }))
    await waitFor(() =>
      expect(screen.getByTestId('agent-model-trigger')).toHaveTextContent('GPT-5.5 · Medium')
    )

    await openSettingsMenu()
    openSubmenu(screen.getByRole('menuitem', { name: /^effort/i }))

    expect(await screen.findByRole('menuitem', { name: 'Medium (default)' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Low' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'High' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Extra High' })).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'Max' })).not.toBeInTheDocument()
  })

  it('passes the selected Codex reasoning with the prompt', async () => {
    renderComposer('conversation-1')

    await openModelSubmenu()
    fireEvent.click(await screen.findByRole('menuitem', { name: 'GPT-5.5' }))
    await openSettingsMenu()
    openSubmenu(screen.getByRole('menuitem', { name: /^effort/i }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'High' }))
    closeMenus()

    await setPromptText('create a task')
    await submitPrompt()

    expect(mockSendTurn).toHaveBeenCalledWith({
      conversationId: 'conversation-1',
      sourceWindowId: 'window-1',
      text: 'create a task',
      attachments: [],
      backendOptions: { backend: 'codex_cli', reasoningEffort: 'high', model: 'gpt-5.5' }
    })
  })

  it('uses the highest suggested Codex model when none was ever picked', async () => {
    localStorage.setItem(
      'memry:agent-model-preference',
      JSON.stringify({ provider: 'codex_cli', models: {} })
    )
    vi.mocked(window.api.agent.listBackendModels).mockImplementation(async ({ backend }) => ({
      backend,
      supportsCustomModel: true,
      models:
        backend === 'codex_cli'
          ? [
              { id: 'gpt-5.4', label: 'GPT-5.4' },
              { id: 'gpt-5.6', label: 'GPT-5.6' },
              { id: 'gpt-5.5', label: 'GPT-5.5' }
            ]
          : [
              { id: 'sonnet', label: 'Sonnet' },
              { id: 'haiku', label: 'Haiku' },
              { id: 'opus', label: 'Opus' }
            ]
    }))
    renderComposer('conversation-1')

    // Opening the menu loads the Codex catalogue, which the default derives from.
    await openSettingsMenu()
    closeMenus()
    await waitFor(() =>
      expect(screen.getByTestId('agent-model-trigger')).toHaveTextContent('GPT-5.6 · Medium')
    )

    await setPromptText('create a task')
    await submitPrompt()

    expect(mockSendTurn).toHaveBeenCalledWith({
      conversationId: 'conversation-1',
      sourceWindowId: 'window-1',
      text: 'create a task',
      attachments: [],
      backendOptions: { backend: 'codex_cli', reasoningEffort: 'medium', model: 'gpt-5.6' }
    })
  })

  it('lists configured local models and passes the pick with the prompt', async () => {
    vi.mocked(window.api.agent.listLocalModels).mockResolvedValue({
      models: ['llama3', 'qwen2.5']
    })
    renderComposer('conversation-1')

    await openModelSubmenu()

    expect(await screen.findByRole('menuitem', { name: 'llama3' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('menuitem', { name: 'llama3' }))

    await waitFor(() =>
      expect(screen.getByTestId('agent-model-trigger')).toHaveTextContent('llama3')
    )

    await setPromptText('summarize offline')
    await submitPrompt()

    expect(mockSendTurn).toHaveBeenCalledWith({
      conversationId: 'conversation-1',
      sourceWindowId: 'window-1',
      text: 'summarize offline',
      attachments: [],
      backendOptions: { backend: 'local_openai_compatible', toolsEnabled: true, model: 'llama3' }
    })
  })

  it('offers Settings from the local section when no local setup exists', async () => {
    renderComposer('conversation-1')

    await openModelSubmenu()

    expect(await screen.findByRole('menuitem', { name: 'Set up in Settings…' })).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'llama3' })).not.toBeInTheDocument()
  })

  it('filters models and offers the query as a custom model id', async () => {
    renderComposer('conversation-1')

    await openModelSubmenu()
    const search = screen.getByPlaceholderText('Search models…')

    fireEvent.change(search, { target: { value: 'sonn' } })
    expect(screen.getByRole('menuitem', { name: 'Sonnet' })).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'Opus' })).not.toBeInTheDocument()

    fireEvent.change(search, { target: { value: 'opus-6' } })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Use "opus-6"' }))

    await waitFor(() =>
      expect(screen.getByTestId('agent-model-trigger')).toHaveTextContent('opus-6 · Extra High')
    )

    await setPromptText('try the new model')
    await submitPrompt()

    expect(mockSendTurn).toHaveBeenCalledWith({
      conversationId: 'conversation-1',
      sourceWindowId: 'window-1',
      text: 'try the new model',
      attachments: [],
      backendOptions: { backend: 'claude_cli', claudeEffort: 'xhigh', model: 'opus-6' }
    })
  })

  it('creates a conversation before sending the first empty-chat prompt', async () => {
    renderComposer(null)

    await setPromptText('draft a plan')
    await submitPrompt()

    expect(mockCreateConversation).toHaveBeenCalledWith({
      backend: 'claude_cli',
      backendModel: 'opus'
    })
    await waitFor(() => {
      expect(mockSendTurn).toHaveBeenCalledWith({
        conversationId: 'conversation-2',
        sourceWindowId: 'window-1',
        text: 'draft a plan',
        attachments: [],
        backendOptions: { backend: 'claude_cli', claudeEffort: 'xhigh', model: 'opus' }
      })
    })
  })

  it('creates a new conversation with selected backend model metadata', async () => {
    renderComposer(null)

    await openModelSubmenu()
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Sonnet' }))

    await setPromptText('draft a plan')
    await submitPrompt()

    expect(mockCreateConversation).toHaveBeenCalledWith({
      backend: 'claude_cli',
      backendModel: 'sonnet'
    })
  })

  it('keeps the first prompt on the send control while the conversation is being created', async () => {
    mockCreateConversation.mockReturnValue(new Promise(() => {}))
    renderComposer(null)

    await setPromptText('draft a plan')
    await userEvent.keyboard('{Enter}')

    expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
  })

  it('allows Shift+Enter to create a newline without submitting', async () => {
    renderComposer('conversation-1')

    await setPromptText('hello')
    await userEvent.keyboard('{Shift>}{Enter}{/Shift}')

    expect(mockSendTurn).not.toHaveBeenCalled()
    expect(screen.getByRole('textbox')).toHaveTextContent('hello')
  })

  it('focuses the prompt editor when the blank input surface is clicked', async () => {
    renderComposer('conversation-1')

    const textbox = screen.getByRole('textbox')
    const promptSurface = textbox.parentElement?.parentElement
    expect(promptSurface).toBeInstanceOf(HTMLElement)

    fireEvent.pointerDown(promptSurface!)

    await waitFor(() => expect(textbox).toHaveFocus())
    await userEvent.keyboard('hello')

    expect(textbox).toHaveTextContent('hello')
  })

  it('submits inline picked refs as readable text and structured attachments', async () => {
    mockSearchQuery.mockResolvedValue({
      groups: [
        {
          type: 'note',
          totalInGroup: 1,
          results: [
            {
              id: 'note-1',
              type: 'note',
              title: 'Planning note',
              snippet: '',
              score: 1,
              normalizedScore: 1,
              matchType: 'title',
              modifiedAt: '2026-05-10T00:00:00.000Z',
              metadata: { type: 'note', path: '/Planning note', tags: [] }
            }
          ]
        }
      ],
      totalCount: 1,
      queryTimeMs: 1
    })
    renderComposer('conversation-1')

    await setPromptText('summarize @plan')
    fireEvent.click(await screen.findByRole('option', { name: /planning note/i }))
    expect(screen.getByTestId('agent-mention-note-note-1')).toHaveTextContent('@Planning note')
    expect(screen.queryByRole('button', { name: /remove.*planning note/i })).not.toBeInTheDocument()
    await submitPrompt()

    expect(mockSearchQuery).toHaveBeenCalledWith({ text: 'plan', limit: 20 })
    expect(mockSendTurn).toHaveBeenCalledWith({
      conversationId: 'conversation-1',
      sourceWindowId: 'window-1',
      text: 'summarize @Planning note',
      attachments: [{ kind: 'note', ref_id: 'note-1', label: 'Planning note' }],
      backendOptions: { backend: 'claude_cli', claudeEffort: 'xhigh', model: 'opus' }
    })
  })

  it('selects the first mention result and supports arrow-key navigation', async () => {
    mockSearchQuery.mockResolvedValue({
      groups: [
        {
          type: 'note',
          totalInGroup: 3,
          results: [
            {
              id: 'note-1',
              type: 'note',
              title: 'Alpha note',
              snippet: '',
              score: 1,
              normalizedScore: 1,
              matchType: 'title',
              modifiedAt: '2026-05-10T00:00:00.000Z',
              metadata: { type: 'note', path: '/Alpha note', tags: [] }
            },
            {
              id: 'note-2',
              type: 'note',
              title: 'Beta note',
              snippet: '',
              score: 1,
              normalizedScore: 1,
              matchType: 'title',
              modifiedAt: '2026-05-10T00:00:00.000Z',
              metadata: { type: 'note', path: '/Beta note', tags: [] }
            },
            {
              id: 'note-3',
              type: 'note',
              title: 'Gamma note',
              snippet: '',
              score: 1,
              normalizedScore: 1,
              matchType: 'title',
              modifiedAt: '2026-05-10T00:00:00.000Z',
              metadata: { type: 'note', path: '/Gamma note', tags: [] }
            }
          ]
        }
      ],
      totalCount: 3,
      queryTimeMs: 1
    })
    renderComposer('conversation-1')

    await setPromptText('summarize @')

    const alphaOption = await screen.findByRole('option', { name: /alpha note/i })
    const betaOption = screen.getByRole('option', { name: /beta note/i })
    const gammaOption = screen.getByRole('option', { name: /gamma note/i })
    expect(alphaOption).toHaveAttribute('aria-selected', 'true')

    await userEvent.keyboard('{ArrowDown}')
    expect(betaOption).toHaveAttribute('aria-selected', 'true')

    await userEvent.keyboard('{ArrowUp}')
    expect(alphaOption).toHaveAttribute('aria-selected', 'true')

    await userEvent.keyboard('{ArrowUp}')
    expect(gammaOption).toHaveAttribute('aria-selected', 'true')

    await userEvent.keyboard('{Enter}')

    expect(mockSendTurn).not.toHaveBeenCalled()
    expect(screen.getByTestId('agent-mention-note-note-3')).toHaveTextContent('@Gamma note')
    expect(mockSearchQuery).toHaveBeenCalledWith({ text: '', limit: 20 })
    await submitPrompt()

    expect(mockSendTurn).toHaveBeenCalledWith({
      conversationId: 'conversation-1',
      sourceWindowId: 'window-1',
      text: 'summarize @Gamma note',
      attachments: [{ kind: 'note', ref_id: 'note-3', label: 'Gamma note' }],
      backendOptions: { backend: 'claude_cli', claudeEffort: 'xhigh', model: 'opus' }
    })
  })

  it('renders soft inline mention tags for note, task, journal, inbox, and calendar refs', async () => {
    mockSearchQuery.mockResolvedValue({
      groups: [
        {
          type: 'note',
          totalInGroup: 1,
          results: [
            {
              id: 'note-1',
              type: 'note',
              title: 'Star Wars Note',
              snippet: '',
              score: 1,
              normalizedScore: 1,
              matchType: 'prefix',
              modifiedAt: '2026-05-10T00:00:00.000Z',
              metadata: { type: 'note', path: '/Planning note', tags: [], emoji: '🔥' }
            }
          ]
        },
        {
          type: 'task',
          totalInGroup: 1,
          results: [
            {
              id: 'task-1',
              type: 'task',
              title: 'Star Wars Task',
              snippet: '',
              score: 1,
              normalizedScore: 1,
              matchType: 'prefix',
              modifiedAt: '2026-05-10T00:00:00.000Z',
              metadata: {
                type: 'task',
                projectId: 'project-1',
                projectName: 'Work',
                projectColor: '#111111',
                statusId: 'todo',
                statusName: 'Todo',
                dueDate: null,
                priority: 0,
                completedAt: null
              }
            }
          ]
        },
        {
          type: 'journal',
          totalInGroup: 1,
          results: [
            {
              id: '2026-05-10',
              type: 'journal',
              title: 'Star Wars Journal',
              snippet: '',
              score: 1,
              normalizedScore: 1,
              matchType: 'prefix',
              modifiedAt: '2026-05-10T00:00:00.000Z',
              metadata: { type: 'journal', date: '2026-05-10', path: '/journal', tags: [] }
            }
          ]
        },
        {
          type: 'inbox',
          totalInGroup: 1,
          results: [
            {
              id: 'inbox-1',
              type: 'inbox',
              title: 'Star Wars Link',
              snippet: '',
              score: 1,
              normalizedScore: 1,
              matchType: 'prefix',
              modifiedAt: '2026-05-10T00:00:00.000Z',
              metadata: {
                type: 'inbox',
                itemType: 'link',
                sourceUrl: 'https://example.com',
                sourceTitle: 'Example',
                filedAt: null
              }
            }
          ]
        }
      ],
      totalCount: 4,
      queryTimeMs: 1
    })
    mockCalendarListEvents.mockResolvedValue({
      events: [
        {
          id: 'event-1',
          title: 'Star Wars Sync',
          description: 'Roadmap',
          location: 'Office',
          startAt: '2026-05-11T09:00:00.000Z',
          endAt: '2026-05-11T09:30:00.000Z',
          timezone: 'UTC',
          isAllDay: false,
          recurrenceRule: null,
          recurrenceExceptions: null,
          attendees: null,
          reminders: null,
          visibility: null,
          colorId: null,
          conferenceData: null,
          parentEventId: null,
          originalStartTime: null,
          targetCalendarId: null,
          archivedAt: null,
          syncedAt: null,
          createdAt: '2026-05-10T00:00:00.000Z',
          modifiedAt: '2026-05-10T00:00:00.000Z'
        },
        {
          id: 'event-2',
          title: 'Unrelated sync',
          description: null,
          location: null,
          startAt: '2026-05-11T10:00:00.000Z',
          endAt: null,
          timezone: 'UTC',
          isAllDay: false,
          recurrenceRule: null,
          recurrenceExceptions: null,
          attendees: null,
          reminders: null,
          visibility: null,
          colorId: null,
          conferenceData: null,
          parentEventId: null,
          originalStartTime: null,
          targetCalendarId: null,
          archivedAt: null,
          syncedAt: null,
          createdAt: '2026-05-10T00:00:00.000Z',
          modifiedAt: '2026-05-10T00:00:00.000Z'
        }
      ]
    })
    renderComposer('conversation-1')

    const textbox = await setPromptText('summarize @star wars')

    const noteOption = await screen.findByRole('option', { name: /star wars note/i })
    expect(noteOption).toHaveTextContent('🔥')
    expect(
      screen.getByRole('option', { name: /star wars task/i }).querySelector('svg')
    ).toBeTruthy()
    expect(
      screen.getByRole('option', { name: /star wars journal/i }).querySelector('svg')
    ).toBeTruthy()
    expect(
      screen.getByRole('option', { name: /star wars link/i }).querySelector('svg')
    ).toBeTruthy()
    expect(
      screen.getByRole('option', { name: /star wars sync/i }).querySelector('svg')
    ).toBeTruthy()
    expect(screen.queryByRole('option', { name: /unrelated sync/i })).not.toBeInTheDocument()

    fireEvent.click(noteOption)
    for (const label of [
      'Star Wars Task',
      'Star Wars Journal',
      'Star Wars Link',
      'Star Wars Sync'
    ]) {
      await userEvent.type(textbox, '@star wars')
      fireEvent.click(await screen.findByRole('option', { name: new RegExp(label, 'i') }))
    }

    expect(screen.getByTestId('agent-mention-note-note-1')).toHaveClass('bg-sky-500/10')
    expect(screen.getByTestId('agent-mention-task-task-1')).toHaveClass('bg-emerald-500/10')
    expect(screen.getByTestId('agent-mention-journal-2026-05-10')).toHaveClass('bg-rose-500/10')
    expect(screen.getByTestId('agent-mention-inbox-inbox-1')).toHaveClass('bg-amber-500/10')
    expect(screen.getByTestId('agent-mention-calendar_event-event-1')).toHaveClass(
      'bg-violet-500/10'
    )
    expect(screen.queryByRole('button', { name: /remove.*star wars/i })).not.toBeInTheDocument()
    expect(mockSearchQuery).toHaveBeenCalledWith({ text: 'star wars', limit: 20 })
    await submitPrompt()

    expect(mockCalendarListEvents).toHaveBeenCalledWith({ includeArchived: false })
    expect(mockSendTurn).toHaveBeenCalledWith({
      conversationId: 'conversation-1',
      sourceWindowId: 'window-1',
      text: 'summarize @Star Wars Note @Star Wars Task @Star Wars Journal @Star Wars Link @Star Wars Sync',
      attachments: [
        { kind: 'note', ref_id: 'note-1', label: 'Star Wars Note' },
        { kind: 'task', ref_id: 'task-1', label: 'Star Wars Task' },
        { kind: 'journal', ref_id: '2026-05-10', label: 'Star Wars Journal' },
        { kind: 'inbox', ref_id: 'inbox-1', label: 'Star Wars Link' },
        { kind: 'calendar_event', ref_id: 'event-1', label: 'Star Wars Sync' }
      ],
      backendOptions: { backend: 'claude_cli', claudeEffort: 'xhigh', model: 'opus' }
    })
  })

  it('removes inline mention tags as atomic nodes', async () => {
    mockSearchQuery.mockResolvedValue({
      groups: [
        {
          type: 'note',
          totalInGroup: 1,
          results: [
            {
              id: 'note-1',
              type: 'note',
              title: 'Star Wars Movies',
              snippet: '',
              score: 1,
              normalizedScore: 1,
              matchType: 'title',
              modifiedAt: '2026-05-10T00:00:00.000Z',
              metadata: { type: 'note', path: '/Star Wars Movies', tags: [] }
            }
          ]
        }
      ],
      totalCount: 1,
      queryTimeMs: 1
    })
    renderComposer('conversation-1')

    await setPromptText('summarize @star wars')
    fireEvent.click(await screen.findByRole('option', { name: /star wars movies/i }))
    expect(screen.getByTestId('agent-mention-note-note-1')).toBeInTheDocument()

    await userEvent.keyboard('{Backspace}{Backspace}')

    expect(screen.queryByTestId('agent-mention-note-note-1')).not.toBeInTheDocument()
    await submitPrompt()

    expect(mockSendTurn).toHaveBeenCalledWith({
      conversationId: 'conversation-1',
      sourceWindowId: 'window-1',
      text: 'summarize',
      attachments: [],
      backendOptions: { backend: 'claude_cli', claudeEffort: 'xhigh', model: 'opus' }
    })
  })

  it('removes inline mention tags with Delete as one unit', async () => {
    mockSearchQuery.mockResolvedValue({
      groups: [
        {
          type: 'note',
          totalInGroup: 1,
          results: [
            {
              id: 'note-1',
              type: 'note',
              title: 'Star Wars Movies',
              snippet: '',
              score: 1,
              normalizedScore: 1,
              matchType: 'title',
              modifiedAt: '2026-05-10T00:00:00.000Z',
              metadata: { type: 'note', path: '/Star Wars Movies', tags: [] }
            }
          ]
        }
      ],
      totalCount: 1,
      queryTimeMs: 1
    })
    renderComposer('conversation-1')

    await setPromptText('@star wars')
    fireEvent.click(await screen.findByRole('option', { name: /star wars movies/i }))
    const mention = screen.getByTestId('agent-mention-note-note-1')
    expect(mention).toBeInTheDocument()

    fireEvent.mouseDown(mention)
    await userEvent.keyboard('{Delete}')

    expect(screen.queryByTestId('agent-mention-note-note-1')).not.toBeInTheDocument()
  })

  it('auto-attaches the current note', async () => {
    mockUseActiveTab.mockReturnValue({
      id: 'tab-1',
      type: 'note',
      title: 'Current brief',
      entityId: 'note-2'
    })
    renderComposer('conversation-1')

    await setPromptText('summarize')
    await submitPrompt()

    expect(mockSendTurn).toHaveBeenCalledWith({
      conversationId: 'conversation-1',
      sourceWindowId: 'window-1',
      text: 'summarize',
      attachments: [{ kind: 'current_note', ref_id: '__current__', label: 'Current brief' }],
      backendOptions: { backend: 'claude_cli', claudeEffort: 'xhigh', model: 'opus' }
    })
  })

  it('drops the current note attachment when the toggle is off', async () => {
    mockUseActiveTab.mockReturnValue({
      id: 'tab-1',
      type: 'note',
      title: 'Current brief',
      entityId: 'note-2'
    })
    renderComposer('conversation-1')

    await openSettingsMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: /include current note/i }))
    closeMenus()

    await setPromptText('summarize')
    await submitPrompt()

    expect(mockSendTurn).toHaveBeenCalledWith({
      conversationId: 'conversation-1',
      sourceWindowId: 'window-1',
      text: 'summarize',
      attachments: [],
      backendOptions: { backend: 'claude_cli', claudeEffort: 'xhigh', model: 'opus' }
    })
  })

  it('replaces send with stop while a turn is in flight', () => {
    mockUseAgentOptional.mockReturnValue({
      state: {
        inFlight: { 'conversation-1': true },
        conversations: {},
        backendStatuses: readyBackendStatuses
      },
      sendTurn: mockSendTurn,
      cancelTurn: mockCancelTurn
    })

    renderComposer('conversation-1')

    expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))

    expect(mockCancelTurn).toHaveBeenCalledWith('conversation-1')
    expect(mockSendTurn).not.toHaveBeenCalled()
  })
})
