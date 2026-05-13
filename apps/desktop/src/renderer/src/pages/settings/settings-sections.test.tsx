import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AccountSettings } from './account-section'
import { AgentProvidersSection } from './agent-providers-section'
import { AIInlineSettings } from './ai-inline-section'
import { AppearanceSettings } from './appearance-section'
import { CalendarSettingsSection } from './calendar-section'
import { CommandLineSettings } from './command-line-section'
import { EditorSettings } from './editor-section'
import { JournalSettings } from './journal-section'
import { toast } from 'sonner'

const mocks = vi.hoisted(() => ({
  authState: { status: 'authenticated', email: 'kaan@example.com' } as Record<string, unknown>,
  logout: vi.fn(),
  syncContext: {
    linkingRequest: null as unknown,
    clearLinkingRequest: vi.fn()
  },
  syncStatus: {
    status: 'idle',
    dotColor: 'bg-green-500',
    label: 'Synced',
    lastSyncLabel: 'now',
    pendingCount: 2,
    pause: vi.fn(),
    resume: vi.fn()
  },
  generalSettings: {
    settings: {
      theme: 'system',
      accentColor: '#6366f1',
      fontSize: 'medium',
      fontFamily: 'system'
    },
    isLoading: false,
    updateSettings: vi.fn()
  },
  calendarPreferences: {
    settings: {
      dayCellClickBehavior: 'journal',
      calendarPageClickOverride: 'inherit'
    },
    isLoading: false,
    updateSettings: vi.fn()
  },
  editorSettings: {
    settings: {
      width: 'medium',
      toolbarMode: 'floating',
      spellCheck: true,
      autoSaveDelay: 5000,
      showWordCount: false
    },
    isLoading: false,
    updateSettings: vi.fn()
  },
  templates: {
    templates: [{ id: 'daily', name: 'Daily template', icon: 'D', isBuiltIn: true }],
    isLoading: false
  },
  journalSettings: {
    settings: {
      defaultTemplate: null,
      showSchedule: true,
      showTasks: true,
      showAIConnections: false,
      showStatsFooter: true
    },
    updateSettings: vi.fn(),
    setDefaultTemplate: vi.fn(),
    isLoading: false
  }
}))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values ? `${key} ${JSON.stringify(values)}` : key
  })
}))

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn()
  }
}))

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    error: vi.fn()
  })
}))

vi.mock('@/components/ui/select', async () => {
  const React = await import('react')
  const SelectContext = React.createContext<{ onValueChange?: (value: string) => void } | null>(
    null
  )
  return {
    Select: ({
      children,
      onValueChange,
      value
    }: {
      children: React.ReactNode
      onValueChange?: (value: string) => void
      value?: string
    }) => (
      <SelectContext.Provider value={{ onValueChange }}>
        <div data-select-value={value}>{children}</div>
      </SelectContext.Provider>
    ),
    SelectTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    SelectValue: ({
      children,
      placeholder
    }: {
      children?: React.ReactNode
      placeholder?: string
    }) => <span>{children ?? placeholder}</span>,
    SelectContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    SelectItem: ({ children, value }: { children: React.ReactNode; value: string }) => {
      const ctx = React.useContext(SelectContext)
      return (
        <button type="button" onClick={() => ctx?.onValueChange?.(value)}>
          {children}
        </button>
      )
    }
  }
})

vi.mock('@/components/ui/switch', () => ({
  Switch: ({
    checked,
    disabled,
    onCheckedChange
  }: {
    checked?: boolean
    disabled?: boolean
    onCheckedChange?: (checked: boolean) => void
  }) => (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onCheckedChange?.(!checked)}
    >
      switch
    </button>
  )
}))

vi.mock('@/components/ui/slider', () => ({
  Slider: ({ onValueCommit }: { onValueCommit?: (value: number[]) => void }) => (
    <button type="button" onClick={() => onValueCommit?.([12000])}>
      slider
    </button>
  )
}))

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children, open }: { children: React.ReactNode; open?: boolean }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}))

vi.mock('@/components/ui/alert-dialog', () => ({
  AlertDialog: ({ children, open }: { children: React.ReactNode; open?: boolean }) =>
    open ? <div>{children}</div> : null,
  AlertDialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  AlertDialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  AlertDialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogCancel: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
  AlertDialogAction: ({
    children,
    onClick
  }: {
    children: React.ReactNode
    onClick?: () => void
  }) => <button onClick={onClick}>{children}</button>
}))

vi.mock('@/contexts/auth-context', () => ({
  useAuth: () => ({
    state: mocks.authState,
    logout: mocks.logout
  })
}))

vi.mock('@/contexts/sync-context', () => ({
  useSync: () => mocks.syncContext
}))

vi.mock('@/hooks/use-sync-status', () => ({
  useSyncStatus: () => mocks.syncStatus
}))

vi.mock('@/hooks/use-general-settings', () => ({
  useGeneralSettings: () => mocks.generalSettings
}))

vi.mock('@/hooks/use-calendar-preferences', () => ({
  useCalendarPreferences: () => mocks.calendarPreferences
}))

vi.mock('@/hooks/use-editor-settings', () => ({
  useEditorSettings: () => mocks.editorSettings
}))

vi.mock('@/hooks/use-templates', () => ({
  useTemplates: () => mocks.templates
}))

vi.mock('@/hooks/use-journal-settings', () => ({
  useJournalSettings: () => mocks.journalSettings
}))

vi.mock('./setup-wizard', () => ({
  SetupWizard: () => <div>setup wizard</div>
}))

vi.mock('@/components/sync/qr-linking', () => ({
  QrLinking: ({ onCancel }: { onCancel: () => void }) => (
    <button type="button" onClick={onCancel}>
      qr linking
    </button>
  )
}))

vi.mock('@/components/sync/linking-approval-dialog', () => ({
  LinkingApprovalDialog: ({
    open,
    onApprove,
    onReject
  }: {
    open: boolean
    onApprove: () => void
    onReject: () => void
  }) =>
    open ? (
      <div>
        <button type="button" onClick={onApprove}>
          approve link
        </button>
        <button type="button" onClick={onReject}>
          reject link
        </button>
      </div>
    ) : null
}))

vi.mock('@/components/sync/device-list', () => ({
  DeviceList: ({ onLinkDevice }: { onLinkDevice: () => void }) => (
    <button type="button" onClick={onLinkDevice}>
      link device
    </button>
  )
}))

vi.mock('@/components/sync/key-rotation-wizard', () => ({
  KeyRotationWizard: ({ open }: { open: boolean }) => (open ? <div>rotation wizard</div> : null)
}))

vi.mock('@/components/settings/recovery-key-dialog', () => ({
  RecoveryKeyDialog: ({ open }: { open: boolean }) => (open ? <div>recovery key</div> : null)
}))

function installWindowApi() {
  window.api = {
    ...window.api,
    agent: {
      getLocalProviderSettings: vi.fn().mockResolvedValue({
        preset: 'ollama',
        baseUrl: 'http://localhost:11434/v1',
        model: 'llama3',
        apiKeyConfigured: false,
        allowNonLoopback: false
      }),
      setLocalProviderSettings: vi.fn(async (input) => ({
        preset: input.preset,
        baseUrl: input.baseUrl,
        model: input.model,
        apiKeyConfigured: Boolean(input.apiKey),
        allowNonLoopback: input.allowNonLoopback
      })),
      listLocalModels: vi.fn().mockResolvedValue({ models: ['llama3', 'qwen2.5'] }),
      testLocalProvider: vi.fn().mockResolvedValue({
        connected: true,
        modelAvailable: true,
        streamingSupported: true,
        toolCallingSupported: false,
        toolContinuationSupported: false,
        toolsEnabled: false,
        detail: null
      }),
      probeLocalProvider: vi.fn().mockResolvedValue({
        connected: true,
        modelAvailable: true,
        streamingSupported: true,
        toolCallingSupported: true,
        toolContinuationSupported: true,
        toolsEnabled: true,
        detail: null
      })
    },
    syncOps: {
      getStorageBreakdown: vi.fn().mockResolvedValue({
        used: 1536,
        limit: 4096,
        breakdown: { notes: 1024, attachments: 256, crdt: 128, other: 128 }
      })
    },
    settings: {
      ...window.api.settings,
      getTerminalCommandStatus: vi.fn().mockResolvedValue({
        supported: true,
        installed: false,
        command: 'memry',
        platform: 'darwin',
        shimPath: '/Users/kaan/.local/bin/memry',
        binDir: '/Users/kaan/.local/bin',
        targetPath: '/Applications/Memry.app/Contents/MacOS/Memry',
        inPath: true,
        pathHint: null
      }),
      installTerminalCommand: vi.fn().mockResolvedValue({
        success: true,
        status: {
          supported: true,
          installed: true,
          command: 'memry',
          platform: 'darwin',
          shimPath: '/Users/kaan/.local/bin/memry',
          binDir: '/Users/kaan/.local/bin',
          targetPath: '/Applications/Memry.app/Contents/MacOS/Memry',
          inPath: true,
          pathHint: null
        }
      }),
      uninstallTerminalCommand: vi.fn().mockResolvedValue({
        success: true,
        status: {
          supported: true,
          installed: false,
          command: 'memry',
          platform: 'darwin',
          shimPath: '/Users/kaan/.local/bin/memry',
          binDir: '/Users/kaan/.local/bin',
          targetPath: '/Applications/Memry.app/Contents/MacOS/Memry',
          inPath: true,
          pathHint: null
        }
      })
    }
  }
  window.electron = {
    ...window.electron,
    ipcRenderer: {
      ...window.electron.ipcRenderer,
      invoke: vi.fn(async (channel: string, payload?: unknown) => {
        if (channel === 'ai-inline:get-settings') {
          return {
            enabled: true,
            provider: 'openai',
            model: 'gpt-4.1',
            apiKey: 'secret',
            baseUrl: ''
          }
        }
        if (channel === 'ai-inline:get-server-port') return 9090
        if (channel === 'ai-inline:set-settings') return { success: true, payload }
        if (channel === 'ai-inline:stop-server') return { success: true }
        if (channel === 'ai-inline:start-server') return { success: true, port: 9191 }
        return null
      })
    }
  }
}

describe('settings section coverage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    installWindowApi()
    mocks.authState = { status: 'authenticated', email: 'kaan@example.com' }
    mocks.syncContext.linkingRequest = null
    mocks.generalSettings.isLoading = false
    mocks.generalSettings.updateSettings.mockResolvedValue(true)
    mocks.calendarPreferences.isLoading = false
    mocks.calendarPreferences.updateSettings.mockResolvedValue(true)
    mocks.editorSettings.isLoading = false
    mocks.editorSettings.updateSettings.mockResolvedValue(true)
    mocks.templates.isLoading = false
    mocks.journalSettings.isLoading = false
    mocks.journalSettings.updateSettings.mockResolvedValue(true)
    mocks.journalSettings.setDefaultTemplate.mockResolvedValue(true)
  })

  it('renders account loading, setup, authenticated, storage, device, security, and linking states', async () => {
    mocks.authState = { status: 'checking' }
    const { rerender } = render(<AccountSettings />)
    expect(screen.getByText('account.header.loading')).toBeInTheDocument()

    mocks.authState = { status: 'unauthenticated' }
    rerender(<AccountSettings />)
    expect(screen.getByText('setup wizard')).toBeInTheDocument()

    mocks.authState = { status: 'authenticated', email: 'kaan@example.com' }
    mocks.syncContext.linkingRequest = { code: '123456' }
    rerender(<AccountSettings />)
    expect(await screen.findByText('kaan@example.com')).toBeInTheDocument()
    expect(screen.getByText(/account.storage.used/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('switch'))
    expect(mocks.syncStatus.pause).toHaveBeenCalled()

    fireEvent.click(screen.getByText('link device'))
    expect(screen.getByText('qr linking')).toBeInTheDocument()

    fireEvent.click(screen.getByText('account.security.recoveryKey.action'))
    expect(screen.getByText('recovery key')).toBeInTheDocument()

    fireEvent.click(screen.getByText('account.security.rotateKeys.action'))
    expect(screen.getByText('rotation wizard')).toBeInTheDocument()

    fireEvent.click(screen.getByText('approve link'))
    expect(mocks.syncContext.clearLinkingRequest).toHaveBeenCalled()
    expect(toast.success).toHaveBeenCalledWith('account.toasts.deviceLinked')
  })

  it('signs out authenticated accounts and reports failures', async () => {
    mocks.logout.mockRejectedValueOnce(new Error('nope')).mockResolvedValueOnce(undefined)
    render(<AccountSettings />)
    await screen.findByText('kaan@example.com')

    fireEvent.click(screen.getByText('account.security.signOut.action'))
    fireEvent.click(screen.getByText('account.signOutDialog.confirm'))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('nope'))

    fireEvent.click(screen.getByText('account.security.signOut.action'))
    fireEvent.click(screen.getByText('account.signOutDialog.confirm'))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('account.toasts.signedOut'))
  })

  it('updates appearance controls and reports failed saves', async () => {
    mocks.generalSettings.updateSettings.mockResolvedValueOnce(false).mockResolvedValue(true)
    render(<AppearanceSettings />)

    fireEvent.click(screen.getByText('appearance.theme.options.dark'))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('appearance.theme.error'))

    fireEvent.click(screen.getByTitle('appearance.accent.presets.amber'))
    await waitFor(() =>
      expect(mocks.generalSettings.updateSettings).toHaveBeenCalledWith({
        accentColor: '#f59e0b'
      })
    )

    fireEvent.click(screen.getByText('L'))
    await waitFor(() =>
      expect(mocks.generalSettings.updateSettings).toHaveBeenCalledWith({ fontSize: 'large' })
    )

    fireEvent.click(screen.getByText('appearance.typography.fontFamily.options.monospace'))
    await waitFor(() =>
      expect(mocks.generalSettings.updateSettings).toHaveBeenCalledWith({
        fontFamily: 'monospace'
      })
    )
  })

  it('renders and updates calendar, editor, and journal settings', async () => {
    render(
      <>
        <CalendarSettingsSection />
        <EditorSettings />
        <JournalSettings />
      </>
    )

    fireEvent.click(screen.getAllByText('calendar.options.openCalendar')[0])
    await waitFor(() =>
      expect(mocks.calendarPreferences.updateSettings).toHaveBeenCalledWith({
        dayCellClickBehavior: 'calendar'
      })
    )

    fireEvent.click(screen.getByText('editor.width.options.wide'))
    await waitFor(() =>
      expect(mocks.editorSettings.updateSettings).toHaveBeenCalledWith({ width: 'wide' })
    )

    fireEvent.click(screen.getAllByRole('switch')[0])
    await waitFor(() =>
      expect(mocks.editorSettings.updateSettings).toHaveBeenCalledWith({
        toolbarMode: 'sticky'
      })
    )

    fireEvent.click(screen.getByText('slider'))
    await waitFor(() =>
      expect(mocks.editorSettings.updateSettings).toHaveBeenCalledWith({ autoSaveDelay: 12000 })
    )

    fireEvent.click(screen.getByText('Daily template'))
    await waitFor(() =>
      expect(mocks.journalSettings.setDefaultTemplate).toHaveBeenCalledWith('daily')
    )

    fireEvent.click(screen.getAllByRole('switch')[5])
    await waitFor(() =>
      expect(mocks.journalSettings.updateSettings).toHaveBeenCalledWith({
        showAIConnections: true
      })
    )
  })

  it('loads and updates AI inline settings, including test connection states', async () => {
    render(<AIInlineSettings />)

    expect(screen.getByText('ai.inline.loading')).toBeInTheDocument()
    await screen.findByText('ai.inline.connection')

    fireEvent.click(screen.getByText('ai.inline.providers.anthropic'))
    await waitFor(() =>
      expect(window.electron.ipcRenderer.invoke).toHaveBeenCalledWith('ai-inline:set-settings', {
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        baseUrl: ''
      })
    )

    fireEvent.click(screen.getByText('ai.inline.test'))
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('ai.inline.connected {"port":9191}')
    )

    fireEvent.click(screen.getByRole('switch'))
    await waitFor(() =>
      expect(window.electron.ipcRenderer.invoke).toHaveBeenCalledWith('ai-inline:set-settings', {
        enabled: false
      })
    )
    expect(toast.success).toHaveBeenCalledWith('ai.inline.disabled')
  })

  it('loads and updates local agent provider settings', async () => {
    render(<AgentProvidersSection />)

    expect(await screen.findByText('agentProviders.header.title')).toBeInTheDocument()
    expect(window.api.agent.getLocalProviderSettings).toHaveBeenCalled()

    fireEvent.click(screen.getByText('agentProviders.presets.lmStudio'))
    expect(screen.getByDisplayValue('http://localhost:1234/v1')).toBeInTheDocument()

    fireEvent.change(screen.getByDisplayValue('http://localhost:1234/v1'), {
      target: { value: 'https://models.example.com/v1' }
    })
    expect(screen.getByText('agentProviders.fields.allowNonLoopback.label')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'agentProviders.actions.models' }))
    expect(await screen.findByText('qwen2.5')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'qwen2.5' }))
    const apiKeyInput = document.querySelector('input[type="password"]')
    expect(apiKeyInput).not.toBeNull()
    fireEvent.change(apiKeyInput as HTMLInputElement, { target: { value: 'local-secret' } })

    fireEvent.click(screen.getByRole('button', { name: 'agentProviders.actions.save' }))
    await waitFor(() =>
      expect(window.api.agent.setLocalProviderSettings).toHaveBeenCalledWith({
        preset: 'lm_studio',
        baseUrl: 'https://models.example.com/v1',
        model: 'qwen2.5',
        allowNonLoopback: true,
        apiKey: 'local-secret'
      })
    )

    fireEvent.click(screen.getByRole('button', { name: 'agentProviders.actions.test' }))
    await screen.findByText('agentProviders.status.toolsDisabled')

    fireEvent.click(screen.getByRole('button', { name: 'agentProviders.actions.probe' }))
    await screen.findByText('agentProviders.status.fullTools')
  })

  it('installs the terminal command from command line settings', async () => {
    render(<CommandLineSettings />)

    await screen.findByText('commandLine.command.descriptionNotInstalled')
    fireEvent.click(screen.getByRole('switch'))

    await waitFor(() => expect(window.api.settings.installTerminalCommand).toHaveBeenCalled())
    expect(toast.success).toHaveBeenCalledWith('commandLine.status.installedToast')
  })
})
