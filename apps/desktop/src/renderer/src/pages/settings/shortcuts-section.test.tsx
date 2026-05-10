import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ShortcutsSettings } from './shortcuts-section'
import { useKeyboardSettings } from '@/hooks/use-keyboard-settings'
import { createMockApi } from '@tests/setup-dom'
import { toast } from 'sonner'

vi.mock('@/hooks/use-keyboard-settings', () => ({
  useKeyboardSettings: vi.fn()
}))

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn()
  }
}))

const useKeyboardSettingsMock = vi.mocked(useKeyboardSettings)

describe('ShortcutsSettings', () => {
  const updateSettings = vi.fn()
  const resetToDefaults = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    updateSettings.mockResolvedValue(true)
    resetToDefaults.mockResolvedValue(true)

    const api = createMockApi()
    api.settings.registerGlobalCapture = vi
      .fn()
      .mockResolvedValue({ registered: true, permissionRequired: false })
    ;(window as Window & { api: unknown }).api = api

    useKeyboardSettingsMock.mockReturnValue({
      settings: {
        overrides: {},
        globalCapture: null
      },
      isLoading: false,
      error: null,
      updateSettings,
      resetToDefaults
    })
  })

  it('shows the loading header while keyboard settings load', () => {
    useKeyboardSettingsMock.mockReturnValue({
      settings: { overrides: {}, globalCapture: null },
      isLoading: true,
      error: null,
      updateSettings,
      resetToDefaults
    })

    render(<ShortcutsSettings />)

    expect(screen.getByText('Keyboard Shortcuts')).toBeInTheDocument()
    expect(screen.getByText('Loading settings...')).toBeInTheDocument()
  })

  it('filters shortcuts and reports an empty result set', async () => {
    render(<ShortcutsSettings />)

    await userEvent.type(screen.getByPlaceholderText('Search shortcuts...'), 'does not exist')

    expect(screen.getByText('No shortcuts match your search')).toBeInTheDocument()
  })

  it('rebounds shortcuts, clears global capture, and resets custom overrides', async () => {
    useKeyboardSettingsMock.mockReturnValue({
      settings: {
        overrides: {
          'nav.newNote': {
            key: 'n',
            modifiers: { meta: true, shift: true }
          }
        },
        globalCapture: {
          key: 'space',
          modifiers: { meta: true }
        }
      },
      isLoading: false,
      error: null,
      updateSettings,
      resetToDefaults
    })

    render(<ShortcutsSettings />)

    await waitFor(() => expect(screen.getByText('Active')).toBeInTheDocument())

    const newNoteRow = screen.getByText('New Note').closest('.group')
    expect(newNoteRow).not.toBeNull()

    await userEvent.click(within(newNoteRow as HTMLElement).getByTitle('Click to rebind'))
    fireEvent.keyDown(window, { key: 'j', metaKey: true })

    expect(updateSettings).toHaveBeenCalledWith({
      overrides: {
        'nav.newNote': {
          key: 'j',
          modifiers: { meta: true, shift: undefined, alt: undefined }
        }
      }
    })

    await userEvent.click(screen.getByTitle('Clear shortcut'))
    expect(updateSettings).toHaveBeenCalledWith({ globalCapture: null })

    await userEvent.click(screen.getByRole('button', { name: /reset all/i }))
    expect(resetToDefaults).toHaveBeenCalled()
    expect(toast.success).toHaveBeenCalledWith('All shortcuts reset to defaults')
  })

  it('shows global capture permission guidance and save failures', async () => {
    const api = createMockApi()
    api.settings.registerGlobalCapture = vi
      .fn()
      .mockResolvedValue({ registered: false, permissionRequired: true })
    ;(window as Window & { api: unknown }).api = api
    updateSettings.mockResolvedValue(false)

    render(<ShortcutsSettings />)

    await waitFor(() => expect(screen.getByText('Permission needed')).toBeInTheDocument())

    await userEvent.click(screen.getByText('Click to set'))
    fireEvent.keyDown(window, { key: 'x', ctrlKey: true })

    expect(updateSettings).toHaveBeenCalledWith({
      globalCapture: {
        key: 'x',
        modifiers: { meta: true, shift: undefined, alt: undefined }
      }
    })
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Failed to save global capture shortcut')
    )
  })
})
