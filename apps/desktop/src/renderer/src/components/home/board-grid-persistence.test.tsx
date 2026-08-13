import { useState } from 'react'
import { describe, it, expect, vi, beforeAll } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { BoardGrid } from './board-grid'
import { TooltipProvider } from '@/components/ui/tooltip'
import { registerWidget } from '@/lib/home/widget-registry'
import { GRID_MARGIN, GRID_ROW_HEIGHT } from '@/lib/home/widget-sizes'
import type { HomePage } from '@/lib/home/types'

// Board width the grid believes it has. Deliberately NARROW (a 1280px window minus the sidebar and
// page padding lands around here) — the regression this file guards is that a drag made at a narrow
// window width was silently dropped. Only WidthProvider is stubbed, and only because its single job
// is measuring the container, which jsdom always reports as 0. The grid itself is the real one.
const BOARD_WIDTH = 900

vi.mock('react-grid-layout/legacy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-grid-layout/legacy')>()
  return {
    ...actual,
    WidthProvider:
      <P,>(Component: React.ComponentType<P & { width: number }>) =>
      (props: P) => <Component {...props} width={BOARD_WIDTH} />
  }
})

// jsdom never lays anything out, so `offsetParent` is null and react-grid-layout refuses to begin a
// drag. Point it at the parent element so the drag pipeline runs for real.
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
    configurable: true,
    get(this: HTMLElement) {
      return this.parentElement
    }
  })
})

registerWidget({
  type: 'bookmarks',
  titleKey: 'Bookmarks',
  icon: 'bookmark',
  defaultLayout: { w: 2, h: 2 },
  defaultConfig: {},
  Component: () => <div>BM</div>
})

const initialBoard: HomePage = {
  id: 'b1',
  name: 'B',
  position: 0,
  widgets: [{ id: 'w1', type: 'bookmarks', x: 0, y: 0, w: 2, h: 2, config: {} }]
}

// Stands in for the persisted board (home_pages row). BoardGrid writes through onChange; a remount
// reads back whatever was written, so the assertions cover a real save→reload round trip.
function makeStore(board: HomePage) {
  return { board }
}

function Harness({ store }: { store: { board: HomePage } }): React.JSX.Element {
  const [board, setBoard] = useState(store.board)
  return (
    <TooltipProvider>
      <BoardGrid
        board={board}
        onChange={(next) => {
          store.board = next
          setBoard(next)
        }}
      />
    </TooltipProvider>
  )
}

function widgetPosition(): { x: number; y: number } {
  const el = document.querySelector<HTMLElement>('.react-grid-item')
  const transform = el?.style.transform ?? ''
  const match = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(transform)
  if (!match) throw new Error(`no translate on grid item: ${transform}`)
  return { x: Number(match[1]), y: Number(match[2]) }
}

// One grid column / row step in pixels, so drags move a whole cell.
const colStep = (BOARD_WIDTH - GRID_MARGIN[0] * 9) / 8 + GRID_MARGIN[0]
const rowStep = GRID_ROW_HEIGHT + GRID_MARGIN[1]

function dragWidget(dx: number, dy: number): void {
  const handle = screen.getByLabelText('Drag widget')
  fireEvent.mouseDown(handle, { clientX: 0, clientY: 0, button: 0 })
  fireEvent.mouseMove(document, { clientX: dx, clientY: dy })
  fireEvent.mouseUp(document, { clientX: dx, clientY: dy })
}

describe('BoardGrid persistence', () => {
  it('persists a drag and restores it on remount', () => {
    const store = makeStore(initialBoard)
    const first = render(<Harness store={store} />)

    const before = widgetPosition()
    dragWidget(Math.round(colStep * 3), Math.round(rowStep * 2))
    // Sanity: the drag really moved the widget on screen (guards against a no-op simulation).
    expect(widgetPosition().x).toBeGreaterThan(before.x)

    // The move reached the persisted board, not just react-grid-layout's internal state.
    expect(store.board.widgets[0]).toMatchObject({ id: 'w1', x: 3 })
    const moved = store.board.widgets[0]

    first.unmount()

    // Remount from what was persisted — the arrangement must come back, not reset to the default.
    render(<Harness store={makeStore(store.board) as { board: HomePage }} />)
    expect(store.board.widgets[0]).toMatchObject({ x: moved.x, y: moved.y })
    const pos = widgetPosition()
    expect(pos.x).toBeGreaterThan(0)
  })
})
