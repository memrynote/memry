import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { WindowControls } from './window-controls'
import { SidebarProvider } from '@/components/ui/sidebar'
import type { Tab, TabSystemState } from '@/contexts/tabs/types'

// The component now reads navigation state from useTabs(); drive it with a holder.
const tabs = vi.hoisted(() => ({
  value: null as unknown as {
    state: TabSystemState
    navBack: ReturnType<typeof vi.fn>
    navForward: ReturnType<typeof vi.fn>
    canNavBack: boolean
    canNavForward: boolean
  }
}))

vi.mock('@/contexts/tabs/context', () => ({
  useTabs: () => tabs.value
}))

// Mock the electron preload bridge — TrafficLights calls window.api.*
const windowApiMock = {
  windowClose: vi.fn(),
  windowMinimize: vi.fn(),
  windowMaximize: vi.fn()
}

type WindowWithApi = Window & { api?: unknown }
let originalApi: unknown

const mkTab = (id: string): Tab => ({
  id,
  type: 'note',
  title: `Note ${id}`,
  icon: 'file-text',
  path: `/note/${id}`,
  isPinned: false,
  isModified: false,
  isPreview: false,
  isDeleted: false,
  openedAt: 0,
  lastAccessedAt: 0
})

const mkState = (tabIds: string[], back: string[], forward: string[]): TabSystemState => ({
  tabGroups: {
    g1: {
      id: 'g1',
      tabs: tabIds.map(mkTab),
      activeTabId: tabIds[tabIds.length - 1] ?? null,
      isActive: true,
      back,
      forward
    }
  },
  layout: { type: 'leaf', tabGroupId: 'g1' },
  activeGroupId: 'g1',
  settings: { restoreSessionOnStart: true, tabCloseButton: 'hover' },
  recentlyClosed: []
})

const setTabs = (over: Partial<typeof tabs.value> = {}): void => {
  tabs.value = {
    state: mkState(['a'], [], []),
    navBack: vi.fn(),
    navForward: vi.fn(),
    canNavBack: false,
    canNavForward: false,
    ...over
  }
}

beforeAll(() => {
  Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false)
  Element.prototype.setPointerCapture = vi.fn()
  Element.prototype.releasePointerCapture = vi.fn()
  Element.prototype.scrollIntoView = vi.fn()
})

beforeEach(() => {
  vi.clearAllMocks()
  setTabs()
  const w = window as WindowWithApi
  originalApi = w.api
  w.api = windowApiMock
})

afterEach(() => {
  const w = window as WindowWithApi
  if (originalApi === undefined) {
    delete w.api
  } else {
    w.api = originalApi
  }
})

function renderWithSidebar(ui: React.ReactElement) {
  return render(<SidebarProvider>{ui}</SidebarProvider>)
}

describe('WindowControls', () => {
  it('renders three traffic-light buttons (close, minimize, maximize)', () => {
    renderWithSidebar(<WindowControls />)
    expect(screen.getByLabelText('Close window')).toBeInTheDocument()
    expect(screen.getByLabelText('Minimize window')).toBeInTheDocument()
    expect(screen.getByLabelText('Maximize window')).toBeInTheDocument()
  })

  it('renders the sidebar toggle', () => {
    renderWithSidebar(<WindowControls />)
    expect(screen.getByRole('button', { name: /toggle sidebar/i })).toBeInTheDocument()
  })

  it('disables both history arrows when there is no history', () => {
    setTabs({ canNavBack: false, canNavForward: false })
    renderWithSidebar(<WindowControls />)
    expect(screen.getByLabelText('Browser back')).toBeDisabled()
    expect(screen.getByLabelText('Browser forward')).toBeDisabled()
  })

  it('navigates one step on left-click when history exists', async () => {
    const user = userEvent.setup()
    setTabs({
      state: mkState(['a', 'b'], ['a'], ['c']),
      canNavBack: true,
      canNavForward: true
    })
    renderWithSidebar(<WindowControls />)

    const back = screen.getByLabelText('Browser back')
    const forward = screen.getByLabelText('Browser forward')
    expect(back).not.toBeDisabled()
    expect(forward).not.toBeDisabled()

    await user.click(back)
    expect(tabs.value.navBack).toHaveBeenCalledTimes(1)
    await user.click(forward)
    expect(tabs.value.navForward).toHaveBeenCalledTimes(1)
  })

  it('shows the last history entries on right-click and jumps N steps', async () => {
    setTabs({
      // back oldest→newest ['a','b','c']; active 'd'. Nearest-first menu: c, b, a.
      state: mkState(['a', 'b', 'c', 'd'], ['a', 'b', 'c'], []),
      canNavBack: true
    })
    renderWithSidebar(<WindowControls />)

    fireEvent.contextMenu(screen.getByLabelText('Browser back'))

    const items = await screen.findAllByRole('menuitem')
    expect(items.map((el) => el.textContent)).toEqual(['Note c', 'Note b', 'Note a'])

    // 3rd entry ('Note a') is 3 steps back.
    fireEvent.click(items[2])
    expect(tabs.value.navBack).toHaveBeenCalledTimes(3)
  })

  it('does not open the back menu when there is no back history', () => {
    setTabs({ canNavBack: false })
    renderWithSidebar(<WindowControls />)
    fireEvent.contextMenu(screen.getByLabelText('Browser back'))
    expect(screen.queryAllByRole('menuitem')).toHaveLength(0)
  })

  it('calls windowClose when the close button is clicked', async () => {
    const user = userEvent.setup()
    renderWithSidebar(<WindowControls />)
    await user.click(screen.getByLabelText('Close window'))
    expect(windowApiMock.windowClose).toHaveBeenCalledTimes(1)
  })
})
