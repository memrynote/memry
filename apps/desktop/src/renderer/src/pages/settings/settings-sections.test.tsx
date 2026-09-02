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
    clearLinkingRequest: vi.fn(),
    triggerSync: vi.fn()
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
      fontSizePx: 16,
      fontFamily: 'system',
      customFontFamily: ''
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
      width: 'normal',
      toolbarMode: 'floating',
      spellCheck: false
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
  }),
  useDirection: () => 'ltr'
}))

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn()
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
    onCheckedChange,
    'aria-label': ariaLabel
  }: {
    checked?: boolean
    disabled?: boolean
    onCheckedChange?: (checked: boolean) => void
    'aria-label'?: string
  }) => (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onCheckedChange?.(!checked)}
    >
      switch
    </button>
  )
}))

vi.mock('@/components/ui/slider', () => ({
  Slider: ({ onValueChange }: { onValueChange?: (value: number[]) => void }) => (
    <button type="button" onClick={() => onValueChange?.([12000])}>
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
  useCalendarPreferences: () => mocks.calendarPreferences,
  // Journal settings reads this for the per-day template row order. A partial
  // mock of this module would fail the whole Journal section, not just the rows.
  useWeekStartsOn: () =>
    (mocks.calendarPreferences.settings as { weekStartDay?: string }).weekStartDay === 'sunday'
      ? 0
      : 1
}))

// The Google connection card lives in Calendar settings but owns its own React
// Query + calendar-service stack. This suite covers the preference controls, so
// stub it out rather than stand up a QueryClientProvider for it here — it has
// its own test in google-calendar-connection.test.tsx.
vi.mock('@/components/settings/google-calendar-connection', () => ({
  GoogleCalendarConnection: () => null
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

function installWindowApi() {
  const agentPreferences = {
    accessMode: 'vault_only',
    toolApprovalMode: 'always_accept'
  }
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
      getPreferences: vi.fn().mockResolvedValue(agentPreferences),
      getBackendStatuses: vi.fn().mockResolvedValue({
        claude_cli: { backend: 'claude_cli', available: true, version: '2.3.0' },
        codex_cli: {
          backend: 'codex_cli',
          available: false,
          reason: 'missing_binary',
          detail: 'Install Codex CLI.',
          version: null,
          minimumRequired: '0.130.0'
        },
        local_openai_compatible: { backend: 'local_openai_compatible', available: true }
      }),
      setPreferences: vi.fn(async (input) => ({ ...agentPreferences, ...input })),
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
    } as unknown as typeof window.api.agent,
    syncOps: {
      getStorageBreakdown: vi.fn().mockResolvedValue({
        used: 1536,
        limit: 4096,
        breakdown: { notes: 1024, attachments: 256, crdt: 128, other: 128 }
      })
    } as unknown as typeof window.api.syncOps,
    account: {
      getBillingStatus: vi.fn().mockResolvedValue({
        plan: 'free',
        status: 'inactive',
        source: 'none',
        limits: {
          storageLimit: 0,
          maxFileSize: 0,
          maxVaults: 0,
          versionHistoryDays: 0
        },
        usage: { storageUsed: 0 },
        expiresAt: null,
        canManageBilling: false
      }),
      refreshBillingStatus: vi.fn().mockResolvedValue({
        plan: 'pro',
        status: 'active',
        source: 'paddle',
        limits: {
          storageLimit: 10 * 1024 * 1024 * 1024,
          maxFileSize: 200 * 1024 * 1024,
          maxVaults: 10,
          versionHistoryDays: 365
        },
        usage: { storageUsed: 1536 },
        expiresAt: null,
        canManageBilling: true
      }),
      startCheckout: vi.fn().mockResolvedValue({ success: true, checkoutUrl: 'https://checkout' }),
      openBillingPortal: vi.fn().mockResolvedValue({
        success: true,
        portalUrl: 'https://paddle.test/portal'
      })
    } as unknown as typeof window.api.account,
    settings: {
      ...window.api.settings,
      getSyncSettings: vi.fn().mockResolvedValue({
        enabled: true,
        autoSync: true,
        attachmentAutoDownload: true
      }),
      setSyncSettings: vi.fn().mockResolvedValue({ success: true }),
      getTerminalCommandStatus: vi.fn().mockResolvedValue({
        supported: true,
        installed: false,
        command: 'memrynote',
        platform: 'darwin',
        shimPath: '/Users/kaan/.local/bin/memrynote',
        binDir: '/Users/kaan/.local/bin',
        targetPath: '/Applications/MemryNote.app/Contents/MacOS/MemryNote',
        inPath: true,
        pathHint: null,
        defaultVaultPath: '/vaults/personal',
        vaults: [
          { path: '/vaults/personal', name: 'personal', isDefault: true },
          { path: '/vaults/work', name: 'work', isDefault: false }
        ]
      }),
      installTerminalCommand: vi.fn().mockResolvedValue({
        success: true,
        status: {
          supported: true,
          installed: true,
          command: 'memrynote',
          platform: 'darwin',
          shimPath: '/Users/kaan/.local/bin/memrynote',
          binDir: '/Users/kaan/.local/bin',
          targetPath: '/Applications/MemryNote.app/Contents/MacOS/MemryNote',
          inPath: true,
          pathHint: null,
          defaultVaultPath: '/vaults/personal',
          vaults: [
            { path: '/vaults/personal', name: 'personal', isDefault: true },
            { path: '/vaults/work', name: 'work', isDefault: false }
          ]
        }
      }),
      uninstallTerminalCommand: vi.fn().mockResolvedValue({
        success: true,
        status: {
          supported: true,
          installed: false,
          command: 'memrynote',
          platform: 'darwin',
          shimPath: '/Users/kaan/.local/bin/memrynote',
          binDir: '/Users/kaan/.local/bin',
          targetPath: '/Applications/MemryNote.app/Contents/MacOS/MemryNote',
          inPath: true,
          pathHint: null,
          defaultVaultPath: '/vaults/personal',
          vaults: [
            { path: '/vaults/personal', name: 'personal', isDefault: true },
            { path: '/vaults/work', name: 'work', isDefault: false }
          ]
        }
      }),
      setTerminalCommandDefaultVault: vi.fn().mockResolvedValue({
        success: true,
        status: {
          supported: true,
          installed: false,
          command: 'memrynote',
          platform: 'darwin',
          shimPath: '/Users/kaan/.local/bin/memrynote',
          binDir: '/Users/kaan/.local/bin',
          targetPath: '/Applications/MemryNote.app/Contents/MacOS/MemryNote',
          inPath: true,
          pathHint: null,
          defaultVaultPath: '/vaults/work',
          vaults: [
            { path: '/vaults/personal', name: 'personal', isDefault: false },
            { path: '/vaults/work', name: 'work', isDefault: true }
          ]
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
    mocks.syncContext.triggerSync.mockResolvedValue(undefined)
    mocks.generalSettings.isLoading = false
    mocks.generalSettings.settings.fontSizePx = 16
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

  it('renders account loading, setup, authenticated, storage, device, and linking states', async () => {
    mocks.authState = { status: 'checking' }
    const { rerender } = render(<AccountSettings />)
    expect(screen.getByText('account.header.loading')).toBeInTheDocument()

    mocks.authState = { status: 'unauthenticated' }
    rerender(<AccountSettings />)
    expect(screen.getByText('setup wizard')).toBeInTheDocument()
    expect(screen.getByText('account.community.prompt')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'account.community.star' })).toBeInTheDocument()

    mocks.authState = { status: 'authenticated', email: 'kaan@example.com' }
    mocks.syncContext.linkingRequest = { code: '123456' }
    rerender(<AccountSettings />)
    expect(await screen.findByText('kaan@example.com')).toBeInTheDocument()
    expect((await screen.findAllByText('account.billing.plans.free')).length).toBeGreaterThan(0)
    expect(screen.getByText(/account.storage.used/)).toBeInTheDocument()
    expect(screen.getByText('account.community.prompt')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'account.community.star' })).toHaveAttribute(
      'href',
      'https://github.com/memrynote/memry'
    )
    expect(screen.getByRole('link', { name: 'account.community.feedback' })).toHaveAttribute(
      'href',
      'https://github.com/memrynote/memry/issues?q=sort%3Aupdated-desc+is%3Aissue+is%3Aopen+'
    )

    // Free plan: the sync toggle is replaced by the upgrade upsell.
    expect(screen.queryByRole('switch')).not.toBeInTheDocument()
    expect(screen.getByText('account.sync.upsell.title')).toBeInTheDocument()

    fireEvent.click(screen.getByText('link device'))
    expect(screen.getByText('qr linking')).toBeInTheDocument()

    fireEvent.click(screen.getByText('approve link'))
    expect(mocks.syncContext.clearLinkingRequest).toHaveBeenCalled()
    expect(toast.success).toHaveBeenCalledWith('account.toasts.deviceLinked')
  })

  it('starts checkout, refreshes billing, and opens Paddle portal from account settings', async () => {
    render(<AccountSettings />)
    expect((await screen.findAllByText('account.billing.plans.free')).length).toBeGreaterThan(0)

    // Free plan renders the marketing CTA in both the sync upsell and billing.
    fireEvent.click(screen.getAllByText('account.billing.actions.unlockSync')[0])
    await waitFor(() => expect(window.api.account.startCheckout).toHaveBeenCalledWith())

    fireEvent.click(screen.getByText('account.billing.actions.refresh'))
    await waitFor(() =>
      expect(screen.getAllByText('account.billing.plans.pro').length).toBeGreaterThan(0)
    )
    expect(mocks.syncContext.triggerSync).toHaveBeenCalled()

    fireEvent.click(screen.getByText('account.billing.actions.manage'))
    await waitFor(() => expect(window.api.account.openBillingPortal).toHaveBeenCalled())
  })

  it('shows the sync toggle for a paid plan and pauses sync on toggle', async () => {
    ;(window.api.account.getBillingStatus as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      plan: 'pro',
      status: 'active',
      source: 'paddle',
      limits: {
        storageLimit: 10 * 1024 * 1024 * 1024,
        maxFileSize: 200 * 1024 * 1024,
        maxVaults: 10,
        versionHistoryDays: 365
      },
      usage: { storageUsed: 1536 },
      expiresAt: null,
      canManageBilling: true
    })
    render(<AccountSettings />)
    expect((await screen.findAllByText('account.billing.plans.pro')).length).toBeGreaterThan(0)
    expect(screen.queryByText('account.sync.upsell.title')).not.toBeInTheDocument()

    // The account section now has a second switch (attachment auto-download);
    // the sync toggle is the first one in the group.
    fireEvent.click(screen.getAllByRole('switch')[0])
    expect(mocks.syncStatus.pause).toHaveBeenCalled()
  })

  it('renders setup while recovery confirmation is still pending', () => {
    mocks.authState = {
      status: 'authenticating',
      email: 'kaan@example.com',
      needsRecoverySetup: true,
      wizardStep: 'recovery-display'
    }

    render(<AccountSettings />)

    expect(screen.getByText('setup wizard')).toBeInTheDocument()
    expect(screen.queryByText('kaan@example.com')).not.toBeInTheDocument()
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
    // Off the default, or the reset button has nothing to write.
    mocks.generalSettings.settings.fontSizePx = 22
    render(<AppearanceSettings />)

    fireEvent.click(screen.getByText('appearance.theme.options.dark'))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('appearance.theme.error'))

    fireEvent.click(screen.getByTitle('appearance.accent.presets.amber'))
    await waitFor(() =>
      expect(mocks.generalSettings.updateSettings).toHaveBeenCalledWith({
        accentColor: '#f59e0b'
      })
    )

    fireEvent.click(screen.getByLabelText('appearance.typography.fontSize.reset'))
    await waitFor(() =>
      expect(mocks.generalSettings.updateSettings).toHaveBeenCalledWith({
        fontSizePx: 16,
        fontSize: 'medium'
      })
    )

    fireEvent.click(screen.getByText('appearance.typography.fontFamily.options.monospace'))
    await waitFor(() =>
      expect(mocks.generalSettings.updateSettings).toHaveBeenCalledWith({
        fontFamily: 'monospace'
      })
    )

    // A typed font name is saved sanitized on blur — the raw text goes into a
    // CSS font stack, so anything that could escape the declaration is dropped.
    const customFontInput = screen.getByLabelText('appearance.typography.customFont.label')
    fireEvent.change(customFontInput, { target: { value: '"Iosevka Term"; color: red' } })
    fireEvent.blur(customFontInput)
    await waitFor(() =>
      expect(mocks.generalSettings.updateSettings).toHaveBeenCalledWith({
        customFontFamily: 'Iosevka Term color red'
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

    fireEvent.click(screen.getByText('editor.width.options.full'))
    await waitFor(() =>
      expect(mocks.editorSettings.updateSettings).toHaveBeenCalledWith({ width: 'full' })
    )

    fireEvent.click(screen.getAllByRole('switch')[1])
    await waitFor(() =>
      expect(mocks.editorSettings.updateSettings).toHaveBeenCalledWith({
        toolbarMode: 'sticky'
      })
    )

    fireEvent.click(screen.getByLabelText('editor.spellCheck.label'))
    await waitFor(() =>
      expect(mocks.editorSettings.updateSettings).toHaveBeenCalledWith({ spellCheck: true })
    )

    fireEvent.click(screen.getByText('Daily template'))
    await waitFor(() =>
      expect(mocks.journalSettings.setDefaultTemplate).toHaveBeenCalledWith('daily')
    )

    // The whole "Sidebar Visibility" group is gone: JournalDayPanel never reads showSchedule /
    // showTasks, and nothing renders AIConnectionsPanel, so none of the three toggles controlled
    // anything. The persisted values are untouched.
    expect(screen.queryByText('journal.groups.sidebarVisibility')).toBeNull()
    expect(screen.queryByText('journal.showSchedule.label')).toBeNull()
    expect(screen.queryByText('journal.showTasks.label')).toBeNull()
    expect(screen.queryByText('journal.showAIConnections.label')).toBeNull()

    fireEvent.click(screen.getAllByRole('switch')[3])
    await waitFor(() =>
      expect(mocks.journalSettings.updateSettings).toHaveBeenCalledWith({
        showStatsFooter: false
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

  it('reports Ollama as unreachable instead of falsely connected', async () => {
    window.electron.ipcRenderer.invoke = vi.fn(async (channel: string) => {
      if (channel === 'ai-inline:get-settings') {
        return { enabled: true, provider: 'ollama', model: 'llama3.2', apiKey: '', baseUrl: '' }
      }
      if (channel === 'ai-inline:get-server-port') return null
      if (channel === 'ai-inline:start-server') return { success: true, port: 59185 }
      if (channel === 'ai-inline:list-ollama-models')
        return { success: false, error: 'fetch failed' }
      return null
    }) as typeof window.electron.ipcRenderer.invoke

    render(<AIInlineSettings />)
    await screen.findByText('ai.inline.connection')

    fireEvent.click(screen.getByText('ai.inline.test'))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'Ollama is not running. Start it with "ollama serve" and try again.'
      )
    )
    expect(toast.success).not.toHaveBeenCalledWith('ai.inline.connected {"port":59185}')
  })

  it('loads and updates local agent provider settings', async () => {
    render(<AgentProvidersSection />)

    expect(await screen.findByText('agentProviders.header.title')).toBeInTheDocument()
    expect(window.api.agent.getLocalProviderSettings).toHaveBeenCalled()
    expect(window.api.agent.getPreferences).toHaveBeenCalled()

    expect(await screen.findByText('agentProviders.permissions.group')).toBeInTheDocument()

    // CLI agent detection status: Claude detected with a version, Codex missing.
    expect(await screen.findByText('agentProviders.cliAgents.claude.label')).toBeInTheDocument()
    expect(
      await screen.findByText('agentProviders.cliAgents.status.detected {"version":"2.3.0"}')
    ).toBeInTheDocument()
    expect(screen.getByText('agentProviders.cliAgents.codex.label')).toBeInTheDocument()
    expect(screen.getByText('agentProviders.cliAgents.status.notDetected')).toBeInTheDocument()

    fireEvent.click(screen.getByText('agentProviders.permissions.access.computerAccess'))
    await waitFor(() =>
      expect(window.api.agent.setPreferences).toHaveBeenCalledWith({
        accessMode: 'computer_access'
      })
    )

    fireEvent.click(screen.getByText('agentProviders.permissions.confirm.askBeforeChanges'))
    await waitFor(() =>
      expect(window.api.agent.setPreferences).toHaveBeenCalledWith({
        toolApprovalMode: 'ask'
      })
    )

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

    // Edits auto-save (debounced) — no Save button — then the connection is re-checked.
    await waitFor(
      () =>
        expect(window.api.agent.setLocalProviderSettings).toHaveBeenCalledWith({
          preset: 'lm_studio',
          baseUrl: 'https://models.example.com/v1',
          model: 'qwen2.5',
          allowNonLoopback: true,
          apiKey: 'local-secret'
        }),
      { timeout: 2000 }
    )
    expect(window.api.agent.testLocalProvider).toHaveBeenCalled()
    await screen.findByText('agentProviders.status.connected', undefined, { timeout: 2000 })
  })

  it('installs the terminal command from command line settings', async () => {
    render(<CommandLineSettings />)

    await screen.findByText('commandLine.command.descriptionNotInstalled')
    fireEvent.click(screen.getByRole('switch'))

    await waitFor(() => expect(window.api.settings.installTerminalCommand).toHaveBeenCalled())
    expect(toast.success).toHaveBeenCalledWith('commandLine.status.installedToast')
  })

  it('sets the default CLI vault from command line settings', async () => {
    render(<CommandLineSettings />)

    await screen.findByText('work')
    fireEvent.click(screen.getByText('work'))

    await waitFor(() =>
      expect(window.api.settings.setTerminalCommandDefaultVault).toHaveBeenCalledWith(
        '/vaults/work'
      )
    )
    expect(toast.success).toHaveBeenCalledWith('commandLine.status.defaultVaultUpdatedToast')
  })
})
