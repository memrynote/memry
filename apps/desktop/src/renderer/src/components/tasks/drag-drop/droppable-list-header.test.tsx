import type React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

import { DroppableListHeader } from './droppable-list-header'

const useDroppableMock = vi.fn()
const useDragContextMock = vi.fn()

vi.mock('@dnd-kit/core', async () => {
  const actual = await vi.importActual<typeof import('@dnd-kit/core')>('@dnd-kit/core')
  return {
    ...actual,
    useDroppable: (options: unknown) => {
      useDroppableMock(options)
      return { setNodeRef: vi.fn(), isOver: false }
    }
  }
})

vi.mock('@/contexts/drag-context', () => ({
  useDragContext: () => useDragContextMock()
}))

describe('DroppableListHeader', () => {
  beforeEach(() => {
    useDroppableMock.mockReset()
    useDragContextMock.mockReset()
    useDragContextMock.mockReturnValue({
      dragState: {
        isDragging: false,
        activeId: null,
        activeIds: [],
        sourceType: 'list',
        sourceContainerId: null,
        overId: null,
        overType: null,
        overSectionId: null,
        overColumnId: null,
        draggedTasks: [],
        lastDroppedId: null
      }
    })
  })

  it('highlights the target section based on normalized drag state, even when header is not directly hovered', () => {
    useDragContextMock.mockReturnValue({
      dragState: {
        isDragging: true,
        activeId: 'task-1',
        activeIds: ['task-1'],
        sourceType: 'list',
        sourceContainerId: 'low',
        overId: 'task-2',
        overType: 'task',
        overSectionId: 'high',
        overColumnId: 'priority-high',
        draggedTasks: [],
        lastDroppedId: null
      }
    })

    render(
      <DroppableListHeader id="group-high" label="High" columnId="priority-high" sectionId="high">
        <div>High header</div>
      </DroppableListHeader>
    )

    const header = screen.getByText('High header').parentElement
    expect(header).toHaveAttribute('data-section-drag-state', 'target-highlighted')
    expect(header?.className).toContain('border-primary/25')
    expect(header?.className).toContain('bg-primary/[0.04]')
    expect(header).not.toHaveAttribute('data-drop-space')
  })

  it('keeps the target section highlighted when hovering a row without column metadata', () => {
    useDragContextMock.mockReturnValue({
      dragState: {
        isDragging: true,
        activeId: 'task-1',
        activeIds: ['task-1'],
        sourceType: 'list',
        sourceContainerId: 'low',
        overId: 'task-2',
        overType: 'task',
        overSectionId: 'high',
        overColumnId: null,
        draggedTasks: [],
        lastDroppedId: null
      }
    })

    render(
      <DroppableListHeader id="group-high" label="High" columnId="priority-high" sectionId="high">
        <div>High body</div>
      </DroppableListHeader>
    )

    const header = screen.getByText('High body').parentElement
    expect(header).toHaveAttribute('data-section-drag-state', 'target-highlighted')
    expect(header?.className).toContain('bg-primary/[0.04]')
  })

  it('dims the source section during a cross-section drag', () => {
    useDragContextMock.mockReturnValue({
      dragState: {
        isDragging: true,
        activeId: 'task-1',
        activeIds: ['task-1'],
        sourceType: 'list',
        sourceContainerId: 'low',
        overId: 'task-2',
        overType: 'task',
        overSectionId: 'high',
        overColumnId: 'priority-high',
        draggedTasks: [],
        lastDroppedId: null
      }
    })

    render(
      <DroppableListHeader id="group-low" label="Low" columnId="priority-low" sectionId="low">
        <div>Low header</div>
      </DroppableListHeader>
    )

    const header = screen.getByText('Low header').parentElement
    expect(header).toHaveAttribute('data-section-drag-state', 'source-dimmed')
    expect(header?.className).toContain('opacity-50')
  })

  it('registers header drops as section-start insert targets', () => {
    useDragContextMock.mockReturnValue({
      dragState: {
        isDragging: true,
        activeId: 'task-1',
        activeIds: ['task-1'],
        sourceType: 'list',
        sourceContainerId: 'low',
        overId: 'group-high',
        overType: 'column',
        overSectionId: 'high',
        overColumnId: 'priority-high',
        overTaskEdge: null,
        sectionDropPosition: 'start',
        draggedTasks: [],
        lastDroppedId: null
      }
    })

    render(
      <DroppableListHeader id="group-high" label="High" columnId="priority-high" sectionId="high">
        <div>High header</div>
      </DroppableListHeader>
    )

    const header = screen.getByText('High header').parentElement
    expect(header).toHaveAttribute('data-drop-space', '40')
    expect(header).toHaveStyle({ paddingBottom: '40px' })

    expect(useDroppableMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          sectionDropPosition: 'start'
        })
      })
    )
  })
})
