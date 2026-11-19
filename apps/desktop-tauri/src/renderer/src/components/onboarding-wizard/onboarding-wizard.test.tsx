import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/telemetry', () => ({ trackTelemetry: vi.fn() }))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string) => key,
    i18n: { resolvedLanguage: 'en', language: 'en', changeLanguage: vi.fn() }
  })
}))

const linking = vi.hoisted(() => ({}) as Record<string, ReturnType<typeof vi.fn>>)
vi.mock('@/services/linking-service', () => ({ linkingService: linking }))

vi.mock('@/components/traffic-lights', () => ({
  TrafficLights: () => <div data-testid="traffic-lights" />
}))

const authState = vi.hoisted(() => ({
  status: 'unauthenticated',
  wizardStep: 'idle',
  email: ''
}))

vi.mock('@/contexts/auth-context', () => ({
  useAuth: () => ({ state: authState })
}))

import { trackTelemetry } from '@/lib/telemetry'
import { commands } from '../../../../generated/bindings'
import { FirstRunGate } from './first-run-gate'
import { finishFirstRunWizard } from './first-run-store'

type Mocked = Record<string, ReturnType<typeof vi.fn>>
const api = window.api as unknown as Record<string, Mocked>

// Some steps offer Continue twice (the header hint and an inline button); either moves on.
const press = async (name: RegExp | string): Promise<void> => {
  const [button] = await screen.findAllByRole('button', { name })
  await act(async () => {
    fireEvent.click(button)
  })
}

const toReady = async (): Promise<void> => {
  await press(/welcome\.getStarted/)
  await press(/keys\.continue/) // theme
  await press(/keys\.continue/) // modules
  await press(/keys\.continue/) // import
  await press(/keys\.continue/) // agent
  await press(/keys\.continue/) // storage
}

const startedCalls = (): unknown[][] =>
  vi.mocked(trackTelemetry).mock.calls.filter(([name]) => name === 'onboarding_started')

const toggle = async (name: string): Promise<void> => {
  await act(async () => {
    fireEvent.click(screen.getByRole('checkbox', { name: new RegExp(name) }))
  })
}

describe('first-run wizard', () => {
  afterEach(() => {
    act(() => finishFirstRunWizard())
  })

  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    authState.status = 'unauthenticated'
    authState.wizardStep = 'idle'
    authState.email = ''
    api.vault.getAll = vi.fn().mockResolvedValue({ vaults: [], currentVault: null })
    api.vault.getDefaultParent = vi.fn().mockResolvedValue('/Users/k/Documents/Memry')
    api.vault.create = vi.fn().mockResolvedValue({ success: true, vault: { path: '/x' } })
    api.import = { list: vi.fn().mockResolvedValue([]), start: vi.fn(), pickFiles: vi.fn() }
    api.onboarding = { detectAgents: vi.fn().mockResolvedValue([]) }
    api.settings.setGeneralSettings = vi.fn().mockResolvedValue({ success: true })
    api.settings.setFeaturesSettings = vi.fn().mockResolvedValue({ success: true })
    api.settings.setAISettings = vi.fn().mockResolvedValue({ success: true })
  })

  it.each(['rejected', 'unsuccessful'])(
    'shows the native adapter diagnostic when a returning user download is %s',
    async (failure) => {
      authState.status = 'authenticated'
      authState.email = 'user@example.test'
      api.vault.listAccount = vi.fn().mockResolvedValue([
        {
          vaultUuid: 'cloud-vault',
          name: 'My Notes',
          itemCount: 12,
          createdAt: 1,
          localPath: null,
          suggestedPath: '/home/user/Memry/my-notes'
        }
      ])
      api.vault.getDefaultParent.mockResolvedValue('/home/user/Memry')
      const diagnostic = 'This build cannot load SQLite: GLIBC_2.38 not found.'
      api.vault.downloadRemote =
        failure === 'rejected'
          ? vi.fn().mockRejectedValue(new Error(diagnostic))
          : vi.fn().mockResolvedValue({ success: false, vault: null, error: diagnostic })

      render(<FirstRunGate />)
      await press(/welcome\.signIn/)

      expect(await screen.findByRole('alert')).toHaveTextContent(diagnostic)
      expect(api.vault.downloadRemote).toHaveBeenCalledWith('cloud-vault', '/home/user/Memry')
      expect(localStorage.getItem('memry:onboarding:tour:v1')).toBeNull()
    }
  )

  it('shows why the account vaults could not load', async () => {
    authState.status = 'authenticated'
    authState.email = 'user@example.test'
    api.vault.listAccount = vi.fn().mockRejectedValue(new Error('The sync server did not answer.'))

    render(<FirstRunGate />)
    await press(/welcome\.signIn/)

    expect(await screen.findByRole('alert')).toHaveTextContent('The sync server did not answer.')
  })

  it('shows the selected Linux destination and preserves its permission error', async () => {
    authState.status = 'authenticated'
    authState.email = 'user@example.test'
    api.vault.listAccount = vi.fn().mockResolvedValue([
      {
        vaultUuid: 'cloud-a',
        name: 'Alpha',
        itemCount: 1,
        createdAt: 1,
        localPath: null,
        suggestedPath: '/home/domain/user/Memry/alpha'
      },
      {
        vaultUuid: 'cloud-b',
        name: 'Beta',
        itemCount: 1,
        createdAt: 1,
        localPath: null,
        suggestedPath: '/home/domain/user/Memry/beta'
      }
    ])
    api.vault.getDefaultParent.mockResolvedValue('/home/domain/user/Memry')
    linking.pickVaultFolder = vi.fn().mockResolvedValue({ path: '/mnt/work/notes' })
    const diagnostic = 'Cannot create /mnt/work/notes. Choose a folder you can write to.'
    api.vault.downloadRemote = vi
      .fn()
      .mockResolvedValue({ success: false, vault: null, error: diagnostic })
    render(<FirstRunGate />)
    await press(/welcome\.signIn/)

    expect(await screen.findByText('/home/domain/user/Memry')).toBeInTheDocument()
    await press(/flow\.change/)
    expect(await screen.findByText('/mnt/work/notes')).toBeInTheDocument()
    await press(/keys\.continue/)

    expect(api.vault.downloadRemote).toHaveBeenCalledWith('cloud-a', '/mnt/work/notes')
    expect(await screen.findByRole('alert')).toHaveTextContent(diagnostic)
  })

  it('offers the Obsidian vaults and installed apps this computer has', async () => {
    vi.mocked(commands.onboardingDetectSources).mockResolvedValue({
      obsidianVaults: [{ name: 'Research', path: '/Users/k/Research' }],
      installedApps: ['bear']
    })
    api.import.list.mockResolvedValue([
      { id: 'bear', name: 'Bear', accountBased: false, fileSpec: { label: 'Bear' } },
      { id: 'evernote', name: 'Evernote', accountBased: false, fileSpec: { label: 'ENEX' } }
    ])
    render(<FirstRunGate />)
    await press(/welcome\.getStarted/)
    await press(/keys\.continue/) // theme
    await press(/keys\.continue/) // modules

    expect(await screen.findByText('/Users/k/Research')).toBeInTheDocument()
    // Installed apps are featured; the rest wait under "Other apps".
    expect(screen.getByRole('checkbox', { name: /Bear/ })).toBeInTheDocument()
    expect(screen.queryByRole('checkbox', { name: /Evernote/ })).not.toBeInTheDocument()
  })

  it('sends no onboarding event while the wizard shows, before the metrics choice', async () => {
    render(<FirstRunGate />)
    await toReady()

    expect(screen.getByRole('switch', { name: /ready\.metrics/ })).toBeInTheDocument()
    expect(trackTelemetry).not.toHaveBeenCalled()
  })

  it('sends onboarding_started once, after metrics are turned on and the vault opens', async () => {
    render(<FirstRunGate />)
    await toReady()
    await press(/ready\.open/)

    await waitFor(() =>
      expect(trackTelemetry).toHaveBeenCalledWith('onboarding_completed', expect.anything())
    )
    expect(startedCalls()).toEqual([
      ['onboarding_started', { surface: 'onboarding', action: 'wizard' }]
    ])
    const [consentAt] = api.telemetry.setEnabled.mock.invocationCallOrder
    const [openAt] = api.vault.create.mock.invocationCallOrder
    const startedAt = vi
      .mocked(trackTelemetry)
      .mock.calls.findIndex(([name]) => name === 'onboarding_started')
    expect(api.telemetry.setEnabled).toHaveBeenCalledWith(true)
    expect(vi.mocked(trackTelemetry).mock.invocationCallOrder[startedAt]).toBeGreaterThan(
      Math.max(consentAt, openAt)
    )
  })

  it('stores the metrics choice before the vault opens, and marks onboarding complete', async () => {
    render(<FirstRunGate />)
    await toReady()
    await act(async () => {
      fireEvent.click(screen.getByRole('switch', { name: /ready\.metrics/ }))
    })
    await press(/ready\.open/)

    await waitFor(() =>
      expect(api.settings.setGeneralSettings).toHaveBeenCalledWith({ onboardingCompleted: true })
    )
    expect(api.telemetry.setEnabled).toHaveBeenCalledWith(false)
    const [consentAt] = api.telemetry.setEnabled.mock.invocationCallOrder
    const [openAt] = api.vault.create.mock.invocationCallOrder
    expect(consentAt).toBeLessThan(openAt)
    expect(localStorage.getItem('memry:onboarding:star:v1')).toBe('pending')
    // Metrics off: the wizard never says it started.
    expect(startedCalls()).toEqual([])
  })

  it('shows the vault picker, not the wizard, when this computer already knows a vault', async () => {
    api.vault.getAll.mockResolvedValue({
      vaults: [{ path: '/Users/k/Notes', name: 'Notes' }],
      currentVault: null
    })
    render(<FirstRunGate />)
    expect(await screen.findByRole('button', { name: /createNewVault/ })).toBeInTheDocument()
    expect(screen.queryByText('onboardingWizard.welcome.getStarted')).not.toBeInTheDocument()
  })

  it('writes the chosen modules into the new vault and skips AI setup when AI is off', async () => {
    render(<FirstRunGate />)

    await press(/welcome\.getStarted/)
    await press(/keys\.continue/) // theme
    await toggle('modules\\.tasks')
    await toggle('modules\\.ai')
    await press(/keys\.continue/) // modules
    await press(/keys\.continue/) // import: nothing picked
    // AI off: no agent step, straight to storage.
    expect(screen.getByText('onboardingWizard.storage.title')).toBeInTheDocument()
    await press(/keys\.continue/)

    await screen.findByText('/Users/k/Documents/Memry/onboardingWizard.preview.notesName')
    expect(screen.queryByText('onboardingWizard.ready.modelTitle')).not.toBeInTheDocument()
    await press(/ready\.open/)

    expect(api.vault.create).toHaveBeenCalledWith(
      '/Users/k/Documents/Memry',
      'onboardingWizard.preview.notesName'
    )
    await waitFor(() =>
      expect(api.settings.setFeaturesSettings).toHaveBeenCalledWith(
        expect.objectContaining({ tasks: false, journal: true })
      )
    )
    expect(api.settings.setAISettings).toHaveBeenCalledWith({ enabled: false })
    expect(commands.aiLoadModel).not.toHaveBeenCalled()
    // The wizard replaces the sidebar tour.
    expect(localStorage.getItem('memry:onboarding:tour:v1')).toBe('1')
  })

  it('shows the focused module in the stage window, and Home once that module is off', async () => {
    render(<FirstRunGate />)
    await press(/welcome\.getStarted/)
    await press(/keys\.continue/) // theme

    await act(async () => {
      fireEvent.focus(screen.getByRole('checkbox', { name: /modules\.calendar/ }))
    })
    expect(screen.getByText('onboardingWizard.preview.allDay')).toBeInTheDocument()

    await toggle('modules\\.calendar') // focuses the row and turns it off
    expect(screen.queryByText('onboardingWizard.preview.allDay')).not.toBeInTheDocument()
    expect(screen.getByText('onboardingWizard.preview.homeGreeting')).toBeInTheDocument()
  })

  it('applies a theme picked from More themes even when the Light card is selected', async () => {
    render(<FirstRunGate />)
    await press(/welcome\.getStarted/)
    await act(async () => {
      fireEvent.click(screen.getByRole('radio', { name: /theme\.light/ }))
    })

    const trigger = screen.getByRole('button', { name: /theme\.moreNone/ })
    await act(async () => {
      fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' })
    })
    await act(async () => {
      fireEvent.click(await screen.findByRole('menuitem', { name: /Nord/ }))
    })

    expect(document.documentElement.getAttribute('data-color-theme')).toBe('nord')
    // Nord has no Warm side, so the light choice moves to White.
    expect(screen.getByRole('radio', { name: /theme\.white/ })).toHaveAttribute(
      'aria-checked',
      'true'
    )
  })

  it('keeps an existing Memry vault’s own settings when the user opens that folder', async () => {
    linking.pickVaultFolder = vi.fn().mockResolvedValue({ path: '/Users/k/Old' })
    vi.mocked(commands.onboardingIsMemryVault).mockResolvedValue(true)
    api.vault.select = vi.fn().mockResolvedValue({ success: true, vault: { path: '/Users/k/Old' } })
    render(<FirstRunGate />)

    await press(/welcome\.getStarted/)
    await press(/keys\.continue/)
    await press(/keys\.continue/)
    await press(/keys\.continue/)
    await press(/keys\.continue/) // agent
    await press(/keys\.continue/) // storage
    await press(/ready\.useExisting/)
    await screen.findByText('onboardingWizard.ready.existingFolderHint')
    await press(/ready\.open/)

    await waitFor(() => expect(api.vault.select).toHaveBeenCalledWith('/Users/k/Old'))
    expect(commands.onboardingIsMemryVault).toHaveBeenCalledWith('/Users/k/Old')
    expect(api.settings.setFeaturesSettings).not.toHaveBeenCalled()
    expect(api.settings.setGeneralSettings).not.toHaveBeenCalledWith(
      expect.objectContaining({ theme: expect.anything() })
    )
  })
})
