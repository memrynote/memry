import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useMenuCommands } from './use-menu-commands'

const mocks = vi.hoisted(() => ({
  state: {} as any,
  activeTab: null as any,
  closeTab: vi.fn(),
  windowClose: vi.fn(),
  zoomIn: vi.fn(),
  zoomOut: vi.fn(),
  resetZoom: vi.fn()
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
vi.mock('./use-ui-zoom', () => ({
  useUiZoom: () => ({
    factor: 1,
    setFactor: vi.fn(),
    zoomIn: mocks.zoomIn,
    zoomOut: mocks.zoomOut,
    resetZoom: mocks.resetZoom
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
    windowClose: mocks.windowClose
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

  it('drives whole-UI zoom from the View menu', () => {
    const dispatch = renderMenu()

    dispatch('view.zoomIn')
    dispatch('view.zoomOut')
    dispatch('view.actualSize')

    expect(mocks.zoomIn).toHaveBeenCalledTimes(1)
    expect(mocks.zoomOut).toHaveBeenCalledTimes(1)
    expect(mocks.resetZoom).toHaveBeenCalledTimes(1)
  })
})
