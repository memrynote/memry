import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { BoardGrid } from './board-grid'
import { TooltipProvider } from '@/components/ui/tooltip'
import { registerWidget } from '@/lib/home/widget-registry'
import type { HomePage } from '@/lib/home/types'

// react-grid-layout measures container width via ResizeObserver (0 in jsdom), so stub it to a
// passthrough that renders children and captures onLayoutChange so tests can fire RGL callbacks.
const rgl = vi.hoisted(() => ({
  onLayoutChange: undefined as undefined | ((layout: unknown, all: unknown) => void)
}))
vi.mock('react-grid-layout/legacy', () => ({
  WidthProvider: (C: unknown) => C,
  Responsive: ({
    children,
    onLayoutChange
  }: {
    children: React.ReactNode
    onLayoutChange?: (layout: unknown, all: unknown) => void
  }) => {
    rgl.onLayoutChange = onLayoutChange
    return <div>{children}</div>
  }
}))

registerWidget({
  type: 'bookmarks',
  titleKey: 'Bookmarks',
  icon: 'bookmark',
  defaultLayout: { w: 4, h: 4 },
  defaultConfig: {},
  Component: () => <div>BM</div>
})

const board: HomePage = {
  id: 'b1',
  name: 'B',
  position: 0,
  widgets: [{ id: 'w1', type: 'bookmarks', x: 0, y: 0, w: 4, h: 4, config: {} }]
}

describe('BoardGrid', () => {
  it('renders a widget and removes it via the menu', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(
      <TooltipProvider>
        <BoardGrid board={board} onChange={onChange} />
      </TooltipProvider>
    )
    expect(screen.getByText('BM')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Widget options' }))
    await user.click(await screen.findByText('Remove'))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ widgets: [] }))
  })

  // Regression: resizing the window narrow makes RGL switch to a fewer-column breakpoint and
  // report a collapsed single-column layout. That must NOT be persisted, or widgets lose their
  // positions and never return when the window is widened again.
  it('ignores a narrow-breakpoint collapse and keeps the lg layout', () => {
    const onChange = vi.fn()
    render(
      <TooltipProvider>
        <BoardGrid board={board} onChange={onChange} />
      </TooltipProvider>
    )
    const collapsed = [{ i: 'w1', x: 0, y: 0, w: 2, h: 4 }]
    const intactLg = [{ i: 'w1', x: 0, y: 0, w: 4, h: 4 }]
    rgl.onLayoutChange?.(collapsed, { lg: intactLg, sm: collapsed })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('persists a real edit made at the lg breakpoint', () => {
    const onChange = vi.fn()
    render(
      <TooltipProvider>
        <BoardGrid board={board} onChange={onChange} />
      </TooltipProvider>
    )
    const editedLg = [{ i: 'w1', x: 2, y: 1, w: 4, h: 4 }]
    rgl.onLayoutChange?.(editedLg, { lg: editedLg })
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        widgets: [expect.objectContaining({ id: 'w1', x: 2, y: 1, w: 4, h: 4 })]
      })
    )
  })
})
