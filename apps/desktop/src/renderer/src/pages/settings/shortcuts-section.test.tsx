import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ShortcutsSettings } from './shortcuts-section'
import { useKeyboardSettings } from '@/hooks/use-keyboard-settings'
import { createMockApi } from '@tests/setup-dom'
import { toast } from 'sonner'
import type { GlobalCaptureResult } from '@memry/contracts/settings-schemas'

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

function mockGlobalCaptureApi(
  current: GlobalCaptureResult,
  onSave: GlobalCaptureResult | Error = { status: 'registered', fallbackRegistered: false }
): { setGlobalCapture: ReturnType<typeof vi.fn> } {
  const api = createMockApi()
  const setGlobalCapture =
    onSave instanceof Error ? vi.fn().mockRejectedValue(onSave) : vi.fn().mockResolvedValue(onSave)
  Object.assign(api.settings, {
    registerGlobalCapture: vi.fn().mockResolvedValue(current),
    setGlobalCapture
  })
  window.api = api as unknown as typeof window.api
  return { setGlobalCapture }
}

function globalCaptureRow(): HTMLElement {
  const row = screen.getByText('Capture a note from anywhere').closest('.group')
  expect(row).not.toBeNull()
  return row as HTMLElement
}

describe('ShortcutsSettings', () => {
  const updateSettings = vi.fn()
  const resetToDefaults = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    updateSettings.mockResolvedValue(true)
    resetToDefaults.mockResolvedValue(true)

    mockGlobalCaptureApi({ status: 'registered', fallbackRegistered: false })

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

    const { setGlobalCapture } = mockGlobalCaptureApi(
      { status: 'registered', fallbackRegistered: false },
      { status: 'unbound', fallbackRegistered: true }
    )

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
    expect(setGlobalCapture).toHaveBeenCalledWith(null)

    await userEvent.click(screen.getByRole('button', { name: /reset all/i }))
    expect(resetToDefaults).toHaveBeenCalled()
    expect(toast.success).toHaveBeenCalledWith('All shortcuts reset to defaults')
  })

  it('shows global capture permission guidance and save failures', async () => {
    const { setGlobalCapture } = mockGlobalCaptureApi(
      { status: 'permission_required', fallbackRegistered: true },
      new Error('No vault is open')
    )

    render(<ShortcutsSettings />)

    await waitFor(() => expect(screen.getByText('Permission needed')).toBeInTheDocument())

    await userEvent.click(screen.getByText('Click to set'))
    fireEvent.keyDown(window, { key: 'x', code: 'KeyX', ctrlKey: true })

    expect(setGlobalCapture).toHaveBeenCalledWith({
      key: 'X',
      modifiers: { meta: true, shift: undefined, alt: undefined }
    })
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Failed to save global capture shortcut')
    )
  })

  it('shows the conflict on the row and keeps the working binding when another app owns the combo', async () => {
    useKeyboardSettingsMock.mockReturnValue({
      settings: { overrides: {}, globalCapture: { key: 'J', modifiers: { meta: true } } },
      isLoading: false,
      error: null,
      updateSettings,
      resetToDefaults
    })
    const { setGlobalCapture } = mockGlobalCaptureApi(
      { status: 'registered', fallbackRegistered: false },
      { status: 'in_use', fallbackRegistered: false }
    )

    render(<ShortcutsSettings />)
    await waitFor(() => expect(screen.getByText('Active')).toBeInTheDocument())

    await userEvent.click(within(globalCaptureRow()).getByTitle('Click to rebind'))
    fireEvent.keyDown(window, { key: 'k', code: 'KeyK', ctrlKey: true, altKey: true })

    expect(setGlobalCapture).toHaveBeenCalledWith({
      key: 'K',
      modifiers: { meta: true, shift: undefined, alt: true }
    })
    expect(
      await screen.findByText('Ctrl+Alt+K is in use by another app. Pick a different combination.')
    ).toHaveAttribute('role', 'alert')
    expect(within(globalCaptureRow()).getByTitle('Click to rebind')).toHaveTextContent('CtrlJ')
    expect(screen.queryByText('Active')).not.toBeInTheDocument()
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('records the physical key so Option combos and Space become valid accelerators', async () => {
    const { setGlobalCapture } = mockGlobalCaptureApi({
      status: 'unbound',
      fallbackRegistered: true
    })

    render(<ShortcutsSettings />)

    await userEvent.click(screen.getByText('Click to set'))
    fireEvent.keyDown(window, { key: '˚', code: 'KeyK', metaKey: true, altKey: true })
    expect(setGlobalCapture).toHaveBeenLastCalledWith({
      key: 'K',
      modifiers: { meta: true, shift: undefined, alt: true }
    })

    await userEvent.click(screen.getByText('Click to set'))
    fireEvent.keyDown(window, { key: ' ', code: 'Space', metaKey: true, shiftKey: true })
    expect(setGlobalCapture).toHaveBeenLastCalledWith({
      key: 'Space',
      modifiers: { meta: true, shift: true, alt: undefined }
    })
  })

  it('explains a saved binding Electron cannot use', async () => {
    useKeyboardSettingsMock.mockReturnValue({
      settings: {
        overrides: {},
        globalCapture: { key: '˚', modifiers: { meta: true, alt: true } }
      },
      isLoading: false,
      error: null,
      updateSettings,
      resetToDefaults
    })
    mockGlobalCaptureApi({ status: 'unsupported', fallbackRegistered: true })

    render(<ShortcutsSettings />)

    expect(
      await screen.findByText(
        "Ctrl+Alt+˚ can't be used as a global shortcut. Pick a different combination."
      )
    ).toBeInTheDocument()
  })

  it('shows when another app owns the default shortcut at launch', async () => {
    mockGlobalCaptureApi({ status: 'unbound', fallbackRegistered: false })

    render(<ShortcutsSettings />)

    expect(
      await screen.findByText(
        'The default shortcut Ctrl+Shift+SPACE is in use by another app. Set a different combination to use Global Capture.'
      )
    ).toHaveAttribute('role', 'alert')
  })
})
