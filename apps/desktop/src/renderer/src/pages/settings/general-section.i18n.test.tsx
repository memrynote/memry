import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nextProvider } from 'react-i18next'
import type { i18n as I18nInstance } from 'i18next'
import { createRendererI18n } from '@memry/i18n/renderer'
import { TabProvider } from '@/contexts/tabs'
import { GeneralSettings } from './general-section'
import { toast } from 'sonner'

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn()
  }
}))

const updateState = {
  currentVersion: '1.0.0',
  status: 'unavailable' as const,
  updateSupported: false,
  availableVersion: null,
  releaseName: null,
  releaseDate: null,
  releaseNotes: null,
  downloadProgressPercent: null,
  lastCheckedAt: null,
  error: null,
  autoDownloadEnabled: false
}

function renderGeneral(i18n: I18nInstance) {
  return render(
    <I18nextProvider i18n={i18n}>
      <TabProvider>
        <GeneralSettings />
      </TabProvider>
    </I18nextProvider>
  )
}

describe('GeneralSettings i18n', () => {
  let i18n: I18nInstance
  const api = window.api as typeof window.api & {
    locale: {
      set: ReturnType<typeof vi.fn>
    }
  }

  beforeEach(async () => {
    vi.clearAllMocks()
    i18n = await createRendererI18n({ locale: 'en' })

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

    api.settings.getGeneralSettings = vi.fn().mockResolvedValue({
      theme: 'system',
      fontSize: 'medium',
      fontFamily: 'system',
      accentColor: '#6366f1',
      startOnBoot: false,
      language: 'en',
      onboardingCompleted: true,
      createInSelectedFolder: true,
      clockFormat: '12h'
    })
    api.settings.setGeneralSettings = vi.fn().mockResolvedValue({ success: true })
    api.settings.getTabSettings = vi.fn().mockResolvedValue({
      restoreSessionOnStart: true,
      tabCloseButton: 'hover'
    })
    api.settings.setTabSettings = vi.fn().mockResolvedValue({ success: true })
    api.updater = {
      getState: vi.fn().mockResolvedValue(updateState),
      checkForUpdates: vi.fn().mockResolvedValue(updateState),
      downloadUpdate: vi.fn().mockResolvedValue(updateState),
      quitAndInstall: vi.fn().mockResolvedValue(undefined)
    }
    api.onUpdaterStateChanged = vi.fn().mockReturnValue(() => {})
    api.locale = {
      set: vi.fn().mockRejectedValue(new Error('locale failed'))
    }
    api.telemetry.getSettings = vi.fn().mockResolvedValue({ enabled: true })
    api.telemetry.setEnabled = vi.fn().mockResolvedValue({ success: true })
  })

  it('renders language and clock labels from the settings namespace', async () => {
    const user = userEvent.setup()

    renderGeneral(i18n)

    expect(await screen.findByText('Language & Region')).toBeInTheDocument()
    expect(screen.getByText('Language')).toBeInTheDocument()
    expect(
      screen.getByText(
        'Most of the app updates immediately. Some system-level text — already-shown notifications, dock label, window title bar — refreshes after the next launch.'
      )
    ).toBeInTheDocument()
    expect(screen.getByText('Time Format')).toBeInTheDocument()

    const selects = screen.getAllByRole('combobox')
    await user.click(selects[1])

    expect(await screen.findAllByText('12-hour')).not.toHaveLength(0)
    expect(screen.getByText('24-hour')).toBeInTheDocument()
  })

  it('uses the settings namespace fallback when locale changes fail', async () => {
    const user = userEvent.setup()

    renderGeneral(i18n)

    await screen.findByText('Language & Region')
    const languageSelect = document.querySelector('#language-select')
    if (!(languageSelect instanceof HTMLElement)) {
      throw new Error('Language select not found')
    }
    await user.click(languageSelect)
    await user.click(await screen.findByText('Türkçe'))

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to change language. Please try again.')
    })
  })

  it('renders public date versions from updater state', async () => {
    api.updater.getState = vi.fn().mockResolvedValue({
      ...updateState,
      currentVersion: 'v2026-05-06',
      status: 'available',
      updateSupported: true,
      availableVersion: 'v2026-05-06.2'
    })

    renderGeneral(i18n)

    expect(await screen.findByText('Installed version v2026-05-06')).toBeInTheDocument()
    expect(screen.getByText('Available version v2026-05-06.2')).toBeInTheDocument()
  })

  it('updates startup, tabs, file creation, telemetry, clock, and downloaded updater actions', async () => {
    const user = userEvent.setup()
    api.updater.getState = vi.fn().mockResolvedValue({
      ...updateState,
      currentVersion: 'v2026-05-06',
      status: 'downloaded',
      updateSupported: true,
      availableVersion: 'v2026-05-06.2'
    })

    renderGeneral(i18n)

    await screen.findByText('Launch at Login')
    const switches = screen.getAllByRole('switch')

    await user.click(switches[0])
    await waitFor(() =>
      expect(api.settings.setGeneralSettings).toHaveBeenCalledWith({ startOnBoot: true })
    )

    await user.click(switches[1])
    await waitFor(() =>
      expect(api.settings.setTabSettings).toHaveBeenCalledWith({ restoreSessionOnStart: false })
    )

    await user.click(switches[2])
    await waitFor(() =>
      expect(api.settings.setGeneralSettings).toHaveBeenCalledWith({
        createInSelectedFolder: false
      })
    )

    await user.click(switches[3])
    await waitFor(() => expect(api.telemetry.setEnabled).toHaveBeenCalledWith(false))

    const selects = screen.getAllByRole('combobox')
    await user.click(selects[1])
    await user.click(await screen.findByText('24-hour'))
    await waitFor(() =>
      expect(api.settings.setGeneralSettings).toHaveBeenCalledWith({ clockFormat: '24h' })
    )

    await user.click(selects[3])
    await user.click(await screen.findByText('Always visible'))
    await waitFor(() =>
      expect(api.settings.setTabSettings).toHaveBeenCalledWith({ tabCloseButton: 'always' })
    )

    await user.click(screen.getByRole('button', { name: 'Restart to Install' }))
    await waitFor(() => expect(api.updater.quitAndInstall).toHaveBeenCalled())
  })

  it('runs updater check/download branches and reports unsupported update checks', async () => {
    const user = userEvent.setup()

    const unsupported = renderGeneral(i18n)

    await screen.findByText('Check for Updates')
    await user.click(screen.getByRole('button', { name: 'Check for Updates' }))
    expect(toast.info).toHaveBeenCalledWith('Auto-updates are available in packaged releases only')
    unsupported.unmount()

    api.updater.getState = vi.fn().mockResolvedValue({
      ...updateState,
      status: 'available',
      updateSupported: true,
      currentVersion: 'v2026-05-06',
      availableVersion: 'v2026-05-06.2'
    })
    api.updater.downloadUpdate = vi.fn().mockResolvedValue({
      ...updateState,
      status: 'downloading',
      updateSupported: true,
      currentVersion: 'v2026-05-06',
      availableVersion: 'v2026-05-06.2',
      downloadProgressPercent: 42
    })

    const available = renderGeneral(i18n)
    await screen.findByText('memrynote v2026-05-06.2 is available to download')
    await user.click(screen.getByRole('button', { name: 'Download Update' }))
    await waitFor(() => expect(api.updater.downloadUpdate).toHaveBeenCalled())
    available.unmount()

    api.updater.getState = vi.fn().mockResolvedValue({
      ...updateState,
      status: 'idle',
      updateSupported: true,
      currentVersion: 'v2026-05-06'
    })
    api.updater.checkForUpdates = vi.fn().mockResolvedValue({
      ...updateState,
      status: 'up-to-date',
      updateSupported: true,
      currentVersion: 'v2026-05-06'
    })

    renderGeneral(i18n)
    await screen.findByText('Check for new releases and install them without leaving the app')
    await user.click(screen.getByRole('button', { name: 'Check for Updates' }))
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('memrynote v2026-05-06 is up to date')
    )
  })
})
