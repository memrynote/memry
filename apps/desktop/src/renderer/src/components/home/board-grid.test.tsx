import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { BoardGrid } from './board-grid'
import { TooltipProvider } from '@/components/ui/tooltip'
import { registerWidget } from '@/lib/home/widget-registry'
import type { HomePage } from '@/lib/home/types'

vi.mock('@dnd-kit/core', () => ({
  DndContext: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  closestCenter: vi.fn(),
  KeyboardSensor: vi.fn(),
  PointerSensor: vi.fn(),
  useSensor: vi.fn(),
  useSensors: vi.fn(() => [])
}))

vi.mock('@dnd-kit/sortable', () => ({
  SortableContext: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  rectSortingStrategy: vi.fn(),
  sortableKeyboardCoordinates: vi.fn(),
  useSortable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    transform: null,
    transition: null
  })
}))

registerWidget({
  type: 'bookmarks',
  titleKey: 'Bookmarks',
  icon: 'bookmark',
  sizes: ['M'],
  defaultSize: 'M',
  defaultConfig: {},
  Component: () => <div>BM</div>
})

const board: HomePage = {
  id: 'b1',
  name: 'B',
  position: 0,
  widgets: [{ id: 'w1', type: 'bookmarks', size: 'M', config: {} }]
}

describe('BoardGrid', () => {
  it('renders a widget and removes it', () => {
    const onChange = vi.fn()
    render(
      <TooltipProvider>
        <BoardGrid board={board} onChange={onChange} editing />
      </TooltipProvider>
    )
    expect(screen.getByText('BM')).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Remove widget'))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ widgets: [] }))
  })
})
