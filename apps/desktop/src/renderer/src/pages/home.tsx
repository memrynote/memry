import { useCallback, useEffect, useRef, useState } from 'react'
import '@/components/home/widgets'
import { HomeHeader } from '@/components/home/home-header'
import { BoardGrid } from '@/components/home/board-grid'
import { BoardEmptyState } from '@/components/home/board-empty-state'
import { BoardManagerDialog } from '@/components/home/board-manager-dialog'
import { HomeDisabledLauncher } from '@/components/home/home-disabled-launcher'
import { useHomeBoards } from '@/hooks/use-home-boards'
import { useHomeSeedGate } from '@/hooks/use-home-seed-gate'
import { useFeatureFlags } from '@/hooks/use-feature-flags'
import { addWidget } from '@/lib/home/layout-reducer'
import { createWidget as makeWidget } from '@/lib/home/widget-registry'
import type { HomePage, WidgetType } from '@/lib/home/types'
import { Skeleton } from '@/components/ui/skeleton'
import { useT } from '@memry/i18n/renderer'
import { useTabs } from '@/contexts/tabs'
import { notesService } from '@/services/notes-service'
import { createLogger } from '@/lib/logger'

const log = createLogger('Page:Home')

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
  const { flags } = useFeatureFlags()
  const { openTab } = useTabs()

  const handleCreateNote = useCallback(async () => {
    try {
      const result = await notesService.create({ title: 'Untitled', content: '' })
      if (result.success && result.note) {
        openTab({
          type: 'note',
          title: result.note.title || 'Untitled',
          icon: 'file-text',
          path: `/note/${result.note.id}`,
          entityId: result.note.id,
          isPinned: false,
          isModified: false,
          isPreview: false,
          isDeleted: false
        })
      }
    } catch (error) {
      log.error('Failed to create new note:', error)
    }
  }, [openTab])

  const [galleryOpen, setGalleryOpen] = useState(false)
  const [managerOpen, setManagerOpen] = useState(false)
  // The header floats over the board (.home-chrome, sticky); its material (blur + translucent
  // background) only appears once content actually scrolls underneath it.
  const [scrolled, setScrolled] = useState(false)
  const {
    boards,
    activeBoard,
    activeBoardId,
    setActiveBoardId,
    isLoading,
    createBoard,
    renameBoard,
    deleteBoard,
    reorderBoards,
    updateWidgets
  } = useHomeBoards()

  // Boards sync, so seeding before the first pull lands would permanently add a
  // default board on every new device. The gate holds until a pull has completed
  // (or 10s, or there is no account at all — see use-home-seed-gate).
  const seedAllowed = useHomeSeedGate()

  // First-run seed: exactly once when no boards exist.
  // `flags.home` is part of the guard, not just the render below it: this effect
  // runs before the `if (!flags.home)` early return, so without it a device with
  // Home disabled would seed a board and push it to every other device.
  const seeded = useRef(false)
  useEffect(() => {
    if (!flags.home || !seedAllowed || isLoading || boards.length > 0 || seeded.current) return
    seeded.current = true
    void (async () => {
      const board = await createBoard(t('home.board.defaultName'))
      // Accumulate so each seeded widget stacks below the previous one.
      const seed: ReturnType<typeof makeWidget>[] = []
      for (const type of DEFAULT_WIDGETS) seed.push(makeWidget(type, seed))
      await updateWidgets(board.id, seed)
      setActiveBoardId(board.id)
    })()
  }, [
    flags.home,
    seedAllowed,
    isLoading,
    boards.length,
    createBoard,
    updateWidgets,
    setActiveBoardId,
    t
  ])

  if (!flags.home) {
    return <HomeDisabledLauncher onCreateNote={() => void handleCreateNote()} />
  }

  const localBoards = boards.map(asLocalPage)
  const localActive = activeBoard ? asLocalPage(activeBoard) : null

  // While the gate is closed there is no board to render and none to hand-create
  // into — show the skeleton rather than a bare header.
  const showSkeleton = isLoading || (boards.length === 0 && !seedAllowed)

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

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    setScrolled(e.currentTarget.scrollTop > 4)
  }

  return (
    <div data-testid="home-page" className="h-full overflow-auto" onScroll={handleScroll}>
      <div className="home-chrome" data-scrolled={scrolled ? 'true' : 'false'}>
        <HomeHeader
          boards={localBoards}
          activeBoardId={activeBoardId}
          onSelectBoard={setActiveBoardId}
          onCreateBoard={() => void createBoard(t('home.board.newName'))}
          onDeleteBoard={(id) => void deleteBoard(id)}
          onManageBoards={() => setManagerOpen(true)}
          showAddWidget={!isLoading && !!localActive}
          galleryOpen={galleryOpen}
          onGalleryOpenChange={setGalleryOpen}
          onAddWidget={handleAddWidget}
        />
      </div>
      <BoardManagerDialog
        boards={localBoards}
        open={managerOpen}
        onOpenChange={setManagerOpen}
        onRename={(id, name) => void renameBoard(id, name)}
        onDelete={(id) => void deleteBoard(id)}
        onReorder={(ids) => void reorderBoards(ids)}
      />
      {showSkeleton && (
        <output
          data-testid="home-board-loading"
          aria-busy="true"
          aria-label={t('state.loading')}
          className="block px-6 pt-6 pb-8"
        >
          <div
            className="grid auto-rows-[7rem] gap-3"
            style={{ gridTemplateColumns: 'repeat(4, minmax(0, 1fr))' }}
          >
            <Skeleton className="col-span-2 row-span-2 h-full rounded-2xl" />
            <Skeleton className="col-span-2 row-span-2 h-full rounded-2xl" />
            <Skeleton className="col-span-1 h-full rounded-2xl" />
            <Skeleton className="col-span-1 h-full rounded-2xl" />
          </div>
        </output>
      )}
      {!showSkeleton && localActive && (
        <div className="px-6 pt-6 pb-8">
          <BoardGrid board={localActive} onChange={handleChange} />
          {localActive.widgets.length === 0 && (
            <BoardEmptyState onAddFirstWidget={handleAddFirstWidget} />
          )}
        </div>
      )}
    </div>
  )
}
