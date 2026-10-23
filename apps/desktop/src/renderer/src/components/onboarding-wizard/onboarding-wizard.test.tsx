import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/telemetry', () => ({ trackTelemetry: vi.fn() }))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string) => key,
    i18n: { resolvedLanguage: 'en', language: 'en', changeLanguage: vi.fn() }
  })
}))

vi.mock('@/components/traffic-lights', () => ({
  TrafficLights: () => <div data-testid="traffic-lights" />
}))

vi.mock('@/contexts/auth-context', () => ({
  useAuth: () => ({ state: { status: 'unauthenticated', wizardStep: 'idle', email: null } })
}))

import { FirstRunGate } from './first-run-gate'

type Mocked = Record<string, ReturnType<typeof vi.fn>>
const api = window.api as unknown as Record<string, Mocked>

// Some steps offer Continue twice (the header hint and an inline button); either moves on.
const press = async (name: RegExp | string): Promise<void> => {
  const [button] = await screen.findAllByRole('button', { name })
  await act(async () => {
    fireEvent.click(button)
  })
}

const toggle = async (name: string): Promise<void> => {
  await act(async () => {
    fireEvent.click(screen.getByRole('checkbox', { name: new RegExp(name) }))
  })
}

describe('first-run wizard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    api.vault.getAll = vi.fn().mockResolvedValue({ vaults: [], currentVault: null })
    api.vault.getDefaultParent = vi.fn().mockResolvedValue('/Users/k/Documents/Memry')
    api.vault.create = vi.fn().mockResolvedValue({ success: true, vault: { path: '/x' } })
    api.import = { list: vi.fn().mockResolvedValue([]), start: vi.fn(), pickFiles: vi.fn() }
    api.onboarding = {
      detectSources: vi.fn().mockResolvedValue({ obsidianVaults: [], installedApps: [] }),
      detectAgents: vi.fn().mockResolvedValue([]),
      isMemryVault: vi.fn().mockResolvedValue(false)
    }
    api.settings.setGeneralSettings = vi.fn().mockResolvedValue({ success: true })
    api.settings.setFeaturesSettings = vi.fn().mockResolvedValue({ success: true })
    api.settings.setAISettings = vi.fn().mockResolvedValue({ success: true })
    ;(window.api as unknown as Record<string, unknown>).onEmbeddingProgress = vi.fn(() => () => {})
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
    await waitFor(() => {
      expect(api.settings.setFeaturesSettings).toHaveBeenCalledWith(
        expect.objectContaining({ tasks: false, journal: true })
      )
    })
    expect(api.settings.setAISettings).toHaveBeenCalledWith({ enabled: false })
    expect(api.settings.loadAIModel).not.toHaveBeenCalled()
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
    api.syncLinking = { pickVaultFolder: vi.fn().mockResolvedValue({ path: '/Users/k/Old' }) }
    api.onboarding.isMemryVault.mockResolvedValue(true)
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

    await waitFor(() => {
      expect(api.vault.select).toHaveBeenCalledWith('/Users/k/Old')
    })
    expect(api.settings.setFeaturesSettings).not.toHaveBeenCalled()
    expect(api.settings.setGeneralSettings).not.toHaveBeenCalledWith(
      expect.objectContaining({ theme: expect.anything() })
    )
  })
})
