import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import HomePage from './home'

// Stub the widgets barrel (Task 9 fills this)
vi.mock('@/components/home/widgets', () => ({}))

// HomePage reads openTab from the tabs context; no TabProvider in this test
vi.mock('@/contexts/tabs', () => ({
  useTabs: () => ({ openTab: vi.fn() })
}))

// Stub child components to avoid dnd-kit / WIDGET_REGISTRY / react-query deps
vi.mock('@/components/home/home-header', () => ({
  HomeHeader: () => null
}))
vi.mock('@/components/home/board-grid', () => ({
  BoardGrid: () => null
}))
vi.mock('@/components/home/widget-gallery', () => ({
  WidgetGallery: () => null
}))

// Stub createWidget so it doesn't throw when registry is empty
vi.mock('@/lib/home/widget-registry', () => ({
  createWidget: vi
    .fn()
    .mockReturnValue({ id: 'w1', type: 'recently-edited', size: 'M', config: {} })
}))

vi.mock('@/components/home/home-disabled-launcher', () => ({
  HomeDisabledLauncher: () => <div data-testid="home-disabled" />
}))

type Board = { id: string; name: string; position: number; widgets: unknown[] }

const state = vi.hoisted(() => ({
  boards: [] as Board[],
  isLoading: false,
  seedAllowed: true,
  homeFlag: true
}))

const createBoard = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ id: 'b1', name: 'Home', position: 0, widgets: [] })
)

vi.mock('@/hooks/use-home-boards', () => ({
  useHomeBoards: () => ({
    boards: state.boards,
    activeBoard: state.boards[0] ?? null,
    activeBoardId: state.boards[0]?.id ?? null,
    setActiveBoardId: vi.fn(),
    isLoading: state.isLoading,
    createBoard,
    renameBoard: vi.fn(),
    deleteBoard: vi.fn(),
    reorderBoards: vi.fn(),
    updateWidgets: vi.fn().mockResolvedValue(undefined)
  })
}))

// The gate has its own test; here it is a dial.
vi.mock('@/hooks/use-home-seed-gate', () => ({
  useHomeSeedGate: () => state.seedAllowed
}))

vi.mock('@/hooks/use-feature-flags', () => ({
  useFeatureFlags: () => ({
    flags: { home: state.homeFlag },
    isLoading: false,
    error: null,
    isEnabled: () => state.homeFlag,
    setFlag: vi.fn()
  })
}))

beforeEach(() => {
  state.boards = []
  state.isLoading = false
  state.seedAllowed = true
  state.homeFlag = true
  createBoard.mockClear()
})

describe('HomePage seed', () => {
  it('seeds a default board when none exist', async () => {
    render(<HomePage />)
    await waitFor(() => expect(createBoard).toHaveBeenCalledWith('Home'))
  })

  // Boards sync now: seeding before the first pull lands permanently adds a
  // default board to the account on every new device.
  it('does not seed while the gate is closed, and shows the skeleton rather than a bare header', async () => {
    state.seedAllowed = false
    render(<HomePage />)

    await screen.findByTestId('home-board-loading')
    expect(createBoard).not.toHaveBeenCalled()
  })

  it('seeds once the gate opens', async () => {
    state.seedAllowed = false
    const { rerender } = render(<HomePage />)
    expect(createBoard).not.toHaveBeenCalled()

    state.seedAllowed = true
    rerender(<HomePage />)

    await waitFor(() => expect(createBoard).toHaveBeenCalledWith('Home'))
  })

  it('never seeds when a board arrives from a remote pull first', async () => {
    state.seedAllowed = false
    const { rerender } = render(<HomePage />)

    // The pull lands: boards arrive and the gate opens in the same render.
    state.boards = [{ id: 'remote-1', name: 'Work', position: 0, widgets: [] }]
    state.seedAllowed = true
    rerender(<HomePage />)

    await waitFor(() => expect(screen.queryByTestId('home-board-loading')).toBeNull())
    expect(createBoard).not.toHaveBeenCalled()
  })

  // The seed effect runs before the `!flags.home` early return, so without
  // flags.home in the guard a device with Home off would seed and push a board.
  it('does not seed when the home feature flag is off', async () => {
    state.homeFlag = false
    render(<HomePage />)

    await screen.findByTestId('home-disabled')
    expect(createBoard).not.toHaveBeenCalled()
  })
})
