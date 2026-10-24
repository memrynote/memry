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
  onLayoutChange: undefined as undefined | ((layout: unknown) => void)
}))
vi.mock('react-grid-layout/legacy', () => ({
  WidthProvider: (C: unknown) => C,
  default: ({
    children,
    onLayoutChange
  }: {
    children: React.ReactNode
    onLayoutChange?: (layout: unknown) => void
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

  // RGL reports a layout on mount and after compaction, not only after a real edit. Persisting
  // those would loop refetch → re-render, so an identical layout must be ignored.
  it('ignores a layout callback that changes nothing', () => {
    const onChange = vi.fn()
    render(
      <TooltipProvider>
        <BoardGrid board={board} onChange={onChange} />
      </TooltipProvider>
    )
    rgl.onLayoutChange?.([{ i: 'w1', x: 0, y: 0, w: 4, h: 4 }])
    expect(onChange).not.toHaveBeenCalled()
  })

  it('persists a real edit', () => {
    const onChange = vi.fn()
    render(
      <TooltipProvider>
        <BoardGrid board={board} onChange={onChange} />
      </TooltipProvider>
    )
    rgl.onLayoutChange?.([{ i: 'w1', x: 2, y: 1, w: 4, h: 4 }])
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        widgets: [expect.objectContaining({ id: 'w1', x: 2, y: 1, w: 4, h: 4 })]
      })
    )
  })
})
