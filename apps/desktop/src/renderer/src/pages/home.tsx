import { useEffect, useRef, useState } from 'react'
import '@/components/home/widgets'
import { HomeHeader } from '@/components/home/home-header'
import { BoardGrid } from '@/components/home/board-grid'
import { BoardEmptyState } from '@/components/home/board-empty-state'
import { useHomeBoards } from '@/hooks/use-home-boards'
import { addWidget } from '@/lib/home/layout-reducer'
import { createWidget as makeWidget } from '@/lib/home/widget-registry'
import type { HomePage, WidgetType } from '@/lib/home/types'
import { Skeleton } from '@/components/ui/skeleton'
import { useT } from '@memry/i18n/renderer'

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
  const { t } = useT('common')
  const [galleryOpen, setGalleryOpen] = useState(false)
  const {
    boards,
    activeBoard,
    activeBoardId,
    setActiveBoardId,
    isLoading,
    createBoard,
    deleteBoard,
    updateWidgets
  } = useHomeBoards()

  // First-run seed: exactly once when no boards exist.
  const seeded = useRef(false)
  useEffect(() => {
    if (isLoading || boards.length > 0 || seeded.current) return
    seeded.current = true
    void (async () => {
      const board = await createBoard(t('home.board.defaultName'))
      // Accumulate so each seeded widget stacks below the previous one.
      const seed: ReturnType<typeof makeWidget>[] = []
      for (const type of DEFAULT_WIDGETS) seed.push(makeWidget(type, seed))
      await updateWidgets(board.id, seed)
      setActiveBoardId(board.id)
    })()
  }, [isLoading, boards.length, createBoard, updateWidgets, setActiveBoardId, t])

  const localBoards = boards.map(asLocalPage)
  const localActive = activeBoard ? asLocalPage(activeBoard) : null

  const handleChange = (next: HomePage) => {
    void updateWidgets(next.id, next.widgets)
  }

  // Empty-state CTA: open the Add-widget popover (anchored in the header).
  const handleAddFirstWidget = () => {
    setGalleryOpen(true)
  }

  const handleAddWidget = (type: WidgetType) => {
    if (!localActive) return
    handleChange(addWidget(localActive, makeWidget(type, localActive.widgets)))
    setGalleryOpen(false)
  }

  return (
    <div data-testid="home-page" className="flex h-full flex-col">
      <HomeHeader
        boards={localBoards}
        activeBoardId={activeBoardId}
        onSelectBoard={setActiveBoardId}
        onCreateBoard={() => void createBoard(t('home.board.newName'))}
        onDeleteBoard={(id) => void deleteBoard(id)}
        showAddWidget={!isLoading && !!localActive}
        galleryOpen={galleryOpen}
        onGalleryOpenChange={setGalleryOpen}
        onAddWidget={handleAddWidget}
      />
      {isLoading && (
        <div
          data-testid="home-board-loading"
          role="status"
          aria-busy="true"
          aria-label={t('state.loading')}
          className="min-h-0 flex-1 overflow-auto px-6 py-6"
        >
          <div
            className="grid auto-rows-[7rem] gap-3"
            style={{ gridTemplateColumns: 'repeat(4, minmax(0, 1fr))' }}
          >
            <Skeleton className="col-span-2 row-span-2 h-full" />
            <Skeleton className="col-span-2 row-span-2 h-full" />
            <Skeleton className="col-span-1 h-full" />
            <Skeleton className="col-span-1 h-full" />
          </div>
        </div>
      )}
      {!isLoading && localActive && (
        <div className="min-h-0 flex-1 overflow-auto px-6 py-6">
          <BoardGrid board={localActive} onChange={handleChange} />
          {localActive.widgets.length === 0 && (
            <BoardEmptyState onAddFirstWidget={handleAddFirstWidget} />
          )}
        </div>
      )}
    </div>
  )
}
