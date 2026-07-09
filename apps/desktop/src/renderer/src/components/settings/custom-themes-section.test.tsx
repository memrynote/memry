import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { CustomThemesSection } from './custom-themes-section'

const darkTheme = {
  id: 'theme-1',
  name: 'Gece',
  base: 'dark' as const,
  variables: { '--background': '#101010' },
  createdAt: '2026-07-09T10:00:00.000Z',
  modifiedAt: '2026-07-09T10:00:00.000Z'
}

const mocks = vi.hoisted(() => ({
  themes: [] as unknown[],
  createTheme: vi.fn(),
  updateTheme: vi.fn(),
  deleteTheme: vi.fn(),
  updateSettings: vi.fn(),
  generalSettings: {
    settings: { theme: 'white', customThemeId: null as string | null, accentColor: '#f97316' },
    isLoading: false,
    updateSettings: vi.fn()
  }
}))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => key })
}))

vi.mock('sonner', () => ({
  toast: { error: vi.fn() }
}))

vi.mock('@/hooks/use-general-settings', () => ({
  useGeneralSettings: () => mocks.generalSettings
}))

vi.mock('@/hooks/use-custom-themes', () => ({
  useCustomThemes: () => ({
    themes: mocks.themes,
    isLoading: false,
    createTheme: mocks.createTheme,
    updateTheme: mocks.updateTheme,
    deleteTheme: mocks.deleteTheme
  })
}))

describe('CustomThemesSection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.themes = [darkTheme]
    mocks.generalSettings.settings.customThemeId = null
    mocks.generalSettings.updateSettings.mockResolvedValue(true)
    mocks.createTheme.mockResolvedValue({ ...darkTheme, id: 'theme-2', name: 'Theme 2' })
    mocks.updateTheme.mockResolvedValue(darkTheme)
    mocks.deleteTheme.mockResolvedValue(true)
  })

  it('shows the empty hint when there are no themes', () => {
    mocks.themes = []
    render(<CustomThemesSection />)
    expect(screen.getByText('appearance.customThemes.empty')).toBeInTheDocument()
  })

  it('creates a theme from the current base and activates it', async () => {
    render(<CustomThemesSection />)

    fireEvent.click(screen.getByText('appearance.customThemes.new'))

    await waitFor(() =>
      expect(mocks.createTheme).toHaveBeenCalledWith({
        name: 'appearance.customThemes.newNamePrefix 2',
        base: 'white'
      })
    )
    await waitFor(() =>
      expect(mocks.generalSettings.updateSettings).toHaveBeenCalledWith({
        customThemeId: 'theme-2',
        theme: 'dark'
      })
    )
  })

  it('applies a theme when its row is clicked', async () => {
    render(<CustomThemesSection />)

    fireEvent.click(screen.getByText('Gece'))

    await waitFor(() =>
      expect(mocks.generalSettings.updateSettings).toHaveBeenCalledWith({
        customThemeId: 'theme-1',
        theme: 'dark'
      })
    )
  })

  it('marks the active theme', () => {
    mocks.generalSettings.settings.customThemeId = 'theme-1'
    render(<CustomThemesSection />)
    expect(screen.getByText('appearance.customThemes.active')).toBeInTheDocument()
  })

  it('duplicates a theme with its variables', async () => {
    render(<CustomThemesSection />)

    fireEvent.click(screen.getByLabelText('appearance.customThemes.duplicate'))

    await waitFor(() =>
      expect(mocks.createTheme).toHaveBeenCalledWith({
        name: 'Gece appearance.customThemes.copySuffix',
        base: 'dark',
        variables: { '--background': '#101010' }
      })
    )
  })

  it('deletes the active theme and falls back to its base', async () => {
    mocks.generalSettings.settings.customThemeId = 'theme-1'
    render(<CustomThemesSection />)

    fireEvent.click(screen.getByLabelText('appearance.customThemes.delete'))

    await waitFor(() => expect(mocks.deleteTheme).toHaveBeenCalledWith('theme-1'))
    await waitFor(() =>
      expect(mocks.generalSettings.updateSettings).toHaveBeenCalledWith({
        customThemeId: null,
        theme: 'dark'
      })
    )
  })

  it('opens the editor, persists a valid hex edit after the debounce, and resets all', async () => {
    vi.useFakeTimers()
    try {
      render(<CustomThemesSection />)

      fireEvent.click(screen.getByLabelText('appearance.customThemes.edit'))
      expect(screen.getByLabelText('appearance.customThemes.editor.name')).toBeInTheDocument()

      const backgroundInput = screen.getByLabelText('Background')
      fireEvent.change(backgroundInput, { target: { value: '#222222' } })

      await vi.advanceTimersByTimeAsync(600)
      expect(mocks.updateTheme).toHaveBeenCalledWith('theme-1', {
        variables: { '--background': '#222222' }
      })

      fireEvent.click(screen.getByText('appearance.customThemes.editor.resetAll'))
      await vi.advanceTimersByTimeAsync(600)
      expect(mocks.updateTheme).toHaveBeenLastCalledWith('theme-1', { variables: {} })
    } finally {
      vi.useRealTimers()
    }
  })

  it('commits a rename from the editor name field on Enter', async () => {
    render(<CustomThemesSection />)

    fireEvent.click(screen.getByLabelText('appearance.customThemes.edit'))
    const nameInput = screen.getByLabelText('appearance.customThemes.editor.name')
    fireEvent.change(nameInput, { target: { value: 'Gündüz' } })
    fireEvent.keyDown(nameInput, { key: 'Enter' })

    await waitFor(() =>
      expect(mocks.updateTheme).toHaveBeenCalledWith('theme-1', { name: 'Gündüz' })
    )
  })

  it('rejects invalid hex input without persisting', async () => {
    vi.useFakeTimers()
    try {
      render(<CustomThemesSection />)

      fireEvent.click(screen.getByLabelText('appearance.customThemes.edit'))
      fireEvent.change(screen.getByLabelText('Background'), { target: { value: 'red' } })

      await vi.advanceTimersByTimeAsync(600)
      expect(mocks.updateTheme).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
