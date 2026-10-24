import { describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'

// `timeBehavior: 'slot'` and `hourHeight` never reach the DOM — only the DOM wrapper
// and its children do. A regression that swapped 'slot' for 'clear', or dropped
// hourHeight, would render identically. Mock useDroppable to capture the exact
// config it was registered with, so we can assert the real invariant alongside the
// DOM smoke test.
const droppableMocks = vi.hoisted(() => ({
  useDroppable: vi.fn((_config: unknown) => ({
    setNodeRef: vi.fn(),
    isOver: false
  }))
}))

vi.mock('@dnd-kit/core', () => ({
  DndContext: ({ children }: { children: React.ReactNode }) => children,
  useDroppable: droppableMocks.useDroppable
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
})
