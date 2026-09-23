import { describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'

// `timeBehavior: 'slot'` and `hourHeight` never reach the DOM — only the DOM wrapper
// and its children do. A regression that swapped 'slot' for 'clear', or dropped
// hourHeight, would render identically. Mock useDroppable to capture the exact
// config it was registered with, so we can assert the real invariant alongside the
// DOM smoke test.
const droppableMocks = vi.hoisted(() => ({
  useDroppable: vi.fn((_config: unknown) => ({
    setNodeRef: vi.fn(),
    isOver: false
  })),
  monitor: null as null | {
    onDragMove?: (event: unknown) => void
    onDragEnd?: () => void
  }
}))

vi.mock('@dnd-kit/core', () => ({
  DndContext: ({ children }: { children: React.ReactNode }) => children,
  useDroppable: droppableMocks.useDroppable,
  useDndMonitor: (handlers: typeof droppableMocks.monitor) => {
    droppableMocks.monitor = handlers
  }
}))

vi.mock('@/contexts/drag-context', () => ({
  useOptionalDragContext: () => null
}))

import { DndContext } from '@dnd-kit/core'
import { CalendarTimedColumnDroppable } from './calendar-timed-column-droppable'

interface DroppableConfig {
  id: string
  data: {
    type: string
    date: Date
    dateKey: string
    timeBehavior: string
    hourHeight: number
  }
}

function lastConfig(): DroppableConfig {
  const call = droppableMocks.useDroppable.mock.calls.at(-1)
  if (!call) throw new Error('useDroppable was not called')
  return call[0] as DroppableConfig
}

describe('CalendarTimedColumnDroppable', () => {
  it('renders a droppable wrapper carrying its date', () => {
    render(
      <DndContext>
        <CalendarTimedColumnDroppable date="2026-07-15" hourHeight={48}>
          <div data-testid="column-body" />
        </CalendarTimedColumnDroppable>
      </DndContext>
    )

    const wrapper = document.querySelector('[data-drop-date="2026-07-15"]')
    expect(wrapper).not.toBeNull()
    expect(document.querySelector('[data-testid="column-body"]')).not.toBeNull()
  })

  it('registers the droppable with timeBehavior "slot" and forwards hourHeight', () => {
    render(
      <DndContext>
        <CalendarTimedColumnDroppable date="2026-07-15" hourHeight={48}>
          <div />
        </CalendarTimedColumnDroppable>
      </DndContext>
    )

    const { data } = lastConfig()
    expect(data.type).toBe('date')
    expect(data.timeBehavior).toBe('slot')
    expect(data.hourHeight).toBe(48)
    expect(data.dateKey).toBe('2026-07-15')
    expect(data.date).toBeInstanceOf(Date)
  })

  it('forwards a different hourHeight per instance instead of a hardcoded value', () => {
    render(
      <DndContext>
        <CalendarTimedColumnDroppable date="2026-07-16" hourHeight={64}>
          <div />
        </CalendarTimedColumnDroppable>
      </DndContext>
    )

    const { data } = lastConfig()
    expect(data.hourHeight).toBe(64)
  })

  describe('drop preview', () => {
    function dragMove(overId: string | null, activeTop: number, data: Record<string, unknown>) {
      act(() => {
        droppableMocks.monitor?.onDragMove?.({
          active: {
            data: { current: data },
            rect: { current: { translated: { top: activeTop } } }
          },
          over: overId ? { id: overId, rect: { top: 100 } } : null
        })
      })
    }

    it('draws the dragged task at the slot it would land on, with its title and range', () => {
      render(
        <CalendarTimedColumnDroppable
          date="2026-07-15"
          hourHeight={40}
          dropPreview
          clockFormat="12h"
        >
          <div />
        </CalendarTimedColumnDroppable>
      )

      // 820px below the column top at 40px/hour is 20:30.
      dragMove('calendar-timed-column:2026-07-15', 920, {
        type: 'calendar-task',
        title: 'Renew passport',
        durationMinutes: 30
      })

      const preview = screen.getByTestId('timed-column-drop-preview')
      expect(preview).toHaveTextContent('Renew passport')
      expect(preview).toHaveTextContent('8:30 – 9:00 PM')
      expect(preview).toHaveStyle({ top: '820px' })

      act(() => droppableMocks.monitor?.onDragEnd?.())
      expect(screen.queryByTestId('timed-column-drop-preview')).toBeNull()
    })

    it('uses the default block length when the task has none, and clears off the column', () => {
      render(
        <CalendarTimedColumnDroppable
          date="2026-07-15"
          hourHeight={40}
          dropPreview
          clockFormat="12h"
        >
          <div />
        </CalendarTimedColumnDroppable>
      )

      dragMove('calendar-timed-column:2026-07-15', 900, { type: 'calendar-task', title: 'Call' })
      expect(screen.getByTestId('timed-column-drop-preview')).toHaveTextContent('8:00 – 9:00 PM')

      dragMove('calendar-timed-column:2026-07-16', 900, { type: 'calendar-task', title: 'Call' })
      expect(screen.queryByTestId('timed-column-drop-preview')).toBeNull()
    })

    it('ignores drags that are not tasks', () => {
      render(
        <CalendarTimedColumnDroppable date="2026-07-15" hourHeight={40} dropPreview>
          <div />
        </CalendarTimedColumnDroppable>
      )

      dragMove('calendar-timed-column:2026-07-15', 900, { type: 'canvas-entity' })
      expect(screen.queryByTestId('timed-column-drop-preview')).toBeNull()
    })
  })
})
