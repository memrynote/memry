import { useEffect, useRef, useState } from 'react'
import '@/components/home/widgets'
import { BoardSwitcher } from '@/components/home/board-switcher'
import { BoardGrid } from '@/components/home/board-grid'
import { BoardEmptyState } from '@/components/home/board-empty-state'
import { WidgetGallery } from '@/components/home/widget-gallery'
import { useHomeBoards } from '@/hooks/use-home-boards'
import { addWidget } from '@/lib/home/layout-reducer'
import { createWidget as makeWidget } from '@/lib/home/widget-registry'
import type { HomePage, WidgetType } from '@/lib/home/types'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Skeleton } from '@/components/ui/skeleton'
import { Plus } from '@/lib/icons/icon-map'
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
  const { t, i18n } = useT('common')
  const [galleryOpen, setGalleryOpen] = useState(false)
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
      const board = await createBoard(t('home.board.defaultName'))
      await updateWidgets(
        board.id,
        DEFAULT_WIDGETS.map((t) => makeWidget(t))
      )
      setActiveBoardId(board.id)
    })()
  }, [isLoading, boards.length, createBoard, updateWidgets, setActiveBoardId, t])

  const localBoards = boards.map(asLocalPage)
  const localActive = activeBoard ? asLocalPage(activeBoard) : null

  const handleChange = (next: HomePage) => {
    void updateWidgets(next.id, next.widgets)
  }

  // Empty-state CTA: open the Add-widget popover.
  const handleAddFirstWidget = () => {
    setGalleryOpen(true)
  }

  const today = new Date().toLocaleDateString(i18n.language, {
    weekday: 'long',
    month: 'long',
    day: 'numeric'
  })

  return (
    <div data-testid="home-page" className="flex h-full flex-col">
      {localActive && (
        <header data-testid="home-header" className="px-6 pt-7 pb-4">
          <h1 data-testid="home-title" className="card-title truncate text-2xl text-foreground">
            {localActive.name}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">{today}</p>
        </header>
      )}
      <BoardSwitcher
        boards={localBoards}
        activeBoardId={activeBoardId}
        onSelect={setActiveBoardId}
        onCreate={() => void createBoard(t('home.board.newName'))}
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
          <div className="mb-5">
            <Popover open={galleryOpen} onOpenChange={setGalleryOpen}>
              <PopoverTrigger asChild>
                <Button type="button" variant="outline" size="sm" data-testid="add-widget-trigger">
                  <Plus className="size-4" aria-hidden="true" />
                  {t('home.addWidget')}
                </Button>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-56 p-2">
                <WidgetGallery
                  onAdd={(type) => {
                    handleChange(addWidget(localActive, makeWidget(type)))
                    setGalleryOpen(false)
                  }}
                />
              </PopoverContent>
            </Popover>
          </div>
          <BoardGrid board={localActive} onChange={handleChange} />
          {localActive.widgets.length === 0 && (
            <BoardEmptyState onAddFirstWidget={handleAddFirstWidget} />
          )}
        </div>
      )}
    </div>
  )
}
