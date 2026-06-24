import { describe, it, expect, vi } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import HomePage from './home'

// Stub the widgets barrel (Task 9 fills this)
vi.mock('@/components/home/widgets', () => ({}))

// Stub child components to avoid dnd-kit / WIDGET_REGISTRY deps
vi.mock('@/components/home/board-switcher', () => ({
  BoardSwitcher: () => null
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

const createBoard = vi.fn().mockResolvedValue({ id: 'b1', name: 'Home', position: 0, widgets: [] })
vi.mock('@/hooks/use-home-boards', () => ({
  useHomeBoards: () => ({
    boards: [],
    activeBoard: null,
    activeBoardId: null,
    setActiveBoardId: vi.fn(),
    isLoading: false,
    createBoard,
    renameBoard: vi.fn(),
    deleteBoard: vi.fn(),
    reorderBoards: vi.fn(),
    updateWidgets: vi.fn().mockResolvedValue(undefined)
  })
}))

describe('HomePage seed', () => {
  it('seeds a default board when none exist', async () => {
    render(<HomePage />)
    await waitFor(() => expect(createBoard).toHaveBeenCalledWith('Home'))
  })
})
