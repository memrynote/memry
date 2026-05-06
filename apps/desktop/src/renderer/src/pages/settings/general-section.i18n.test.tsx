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
  error: null
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
    api.settings.getTabSettings = vi.fn().mockResolvedValue({
      previewMode: true,
      restoreSessionOnStart: true,
      tabCloseButton: 'hover'
    })
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
})
