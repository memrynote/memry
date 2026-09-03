import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useMenuCommands } from './use-menu-commands'

const mocks = vi.hoisted(() => ({
  state: {} as any,
  activeTab: null as any,
  closeTab: vi.fn(),
  windowClose: vi.fn(),
  setZoomFactor: vi.fn(),
  updateSettings: vi.fn(),
  generalSettings: { zoomFactor: 1 } as { zoomFactor: number }
}))

vi.mock('@/contexts/tabs', () => ({
  useTabs: () => ({ state: mocks.state, closeTab: mocks.closeTab }),
  useActiveTab: () => mocks.activeTab
}))
vi.mock('@/components/ui/sidebar', () => ({ useSidebar: () => ({ toggleSidebar: vi.fn() }) }))
vi.mock('@/contexts/day-panel-context', () => ({ useDayPanel: () => ({ toggle: vi.fn() }) }))
vi.mock('@/contexts/settings-modal-context', () => ({
  useSettingsModal: () => ({ open: vi.fn() })
}))
vi.mock('next-themes', () => ({ useTheme: () => ({ setTheme: vi.fn() }) }))
// The zoom commands are delegated to useAppZoom, which reads the same settings
// hook and binds the ⌘0/⌘+/⌘- keystrokes through the shared shortcut base.
vi.mock('@/contexts/hint-mode', () => ({ hintModeActiveRef: { current: false } }))
vi.mock('@/hooks/use-general-settings', () => ({
  useGeneralSettings: () => ({
    settings: mocks.generalSettings,
    isLoading: false,
    updateSettings: mocks.updateSettings
  })
}))
vi.mock('@/lib/menu-commands', () => ({
  isEditorMenuCommand: () => false,
  runEditorMenuCommand: vi.fn(),
  runHistoryMenuCommand: vi.fn()
}))

/** Renders the hook and returns a dispatcher for native menu commands. */
function renderMenu(): (command: string) => void {
  let listener: (payload: { command: string }) => void = () => {}
  ;(window as Window & { api: unknown }).api = {
    onMenuCommand: (cb: (payload: { command: string }) => void) => {
      listener = cb
      return () => {}
    },
    windowClose: mocks.windowClose,
    setZoomFactor: mocks.setZoomFactor
  }
  renderHook(() => useMenuCommands({ onNewNote: vi.fn(), onOpenSearch: vi.fn() }))
  return (command: string) => listener({ command })
}

const groupWith = (tabs: any[]) => ({
  activeGroupId: 'main',
  tabGroups: { main: { id: 'main', tabs, activeTabId: tabs[0]?.id ?? null } }
})

describe('useMenuCommands', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.activeTab = { id: 'note-1', type: 'note' }
    mocks.state = groupWith([mocks.activeTab])
    mocks.generalSettings = { zoomFactor: 1 }
    mocks.updateSettings.mockResolvedValue(true)
  })

  it('closes the active tab on File → Close Tab', () => {
    renderMenu()('file.closeTab')

    expect(mocks.closeTab).toHaveBeenCalledWith('note-1')
    expect(mocks.windowClose).not.toHaveBeenCalled()
  })

  it('closes the window when Close Tab is invoked on the last Home tab', () => {
    mocks.activeTab = { id: 'home', type: 'home' }
    mocks.state = groupWith([mocks.activeTab])

    renderMenu()('file.closeTab')

    expect(mocks.windowClose).toHaveBeenCalled()
    expect(mocks.closeTab).not.toHaveBeenCalled()
  })

  it('closes the window on File → Close Window', () => {
    renderMenu()('file.closeWindow')

    expect(mocks.windowClose).toHaveBeenCalled()
    expect(mocks.closeTab).not.toHaveBeenCalled()
  })

  it('steps the zoom up on View → Zoom In and persists it', () => {
    mocks.generalSettings = { zoomFactor: 1.2 }

    renderMenu()('view.zoomIn')

    expect(mocks.setZoomFactor).toHaveBeenCalledWith(1.3)
    expect(mocks.updateSettings).toHaveBeenCalledWith({ zoomFactor: 1.3 })
  })

  it('steps the zoom down on View → Zoom Out and persists it', () => {
    mocks.generalSettings = { zoomFactor: 1.2 }

    renderMenu()('view.zoomOut')

    expect(mocks.setZoomFactor).toHaveBeenCalledWith(1.1)
    expect(mocks.updateSettings).toHaveBeenCalledWith({ zoomFactor: 1.1 })
  })

  it('returns to 100% on View → Actual Size', () => {
    mocks.generalSettings = { zoomFactor: 1.7 }

    renderMenu()('view.actualSize')

    expect(mocks.setZoomFactor).toHaveBeenCalledWith(1)
    expect(mocks.updateSettings).toHaveBeenCalledWith({ zoomFactor: 1 })
  })
})
