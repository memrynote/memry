import { useEffect, useRef } from 'react'
import '@/components/home/widgets'
import { BoardSwitcher } from '@/components/home/board-switcher'
import { BoardGrid } from '@/components/home/board-grid'
import { WidgetGallery } from '@/components/home/widget-gallery'
import { useHomeBoards } from '@/hooks/use-home-boards'
import { addWidget } from '@/lib/home/layout-reducer'
import { createWidget as makeWidget } from '@/lib/home/widget-registry'
import type { HomePage, WidgetType } from '@/lib/home/types'

const DEFAULT_WIDGETS: WidgetType[] = ['recently-edited', 'bookmarks']

// The API returns HomePage with WidgetInstance.type typed as string (contracts schema).
// The renderer uses a narrowed WidgetType literal union — structurally identical at runtime.
function asLocalPage(page: {
  id: string
  name: string
  icon?: string
  position: number
  widgets: unknown[]
}): HomePage {
  return page as unknown as HomePage
}

export default function HomePage(): React.JSX.Element {
  const {
    boards,
    activeBoard,
    activeBoardId,
    setActiveBoardId,
    isLoading,
    createBoard,
    updateWidgets
  } = useHomeBoards()

  // First-run seed: exactly once when no boards exist.
  const seeded = useRef(false)
  useEffect(() => {
    if (isLoading || boards.length > 0 || seeded.current) return
    seeded.current = true
    void (async () => {
      const board = await createBoard('Home')
      await updateWidgets(
        board.id,
        DEFAULT_WIDGETS.map((t) => makeWidget(t))
      )
      setActiveBoardId(board.id)
    })()
  }, [isLoading, boards.length, createBoard, updateWidgets, setActiveBoardId])

  const localBoards = boards.map(asLocalPage)
  const localActive = activeBoard ? asLocalPage(activeBoard) : null

  const handleChange = (next: HomePage) => {
    void updateWidgets(next.id, next.widgets)
  }

  return (
    <div className="flex h-full flex-col">
      <BoardSwitcher
        boards={localBoards}
        activeBoardId={activeBoardId}
        onSelect={setActiveBoardId}
        onCreate={() => void createBoard('New board')}
      />
      {localActive && (
        <div className="min-h-0 flex-1 overflow-auto p-4">
          <div className="mb-3">
            <WidgetGallery
              onAdd={(type) => handleChange(addWidget(localActive, makeWidget(type)))}
            />
          </div>
          <BoardGrid board={localActive} onChange={handleChange} editing />
        </div>
      )}
    </div>
  )
}
