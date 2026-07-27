import * as React from 'react'
import { useCallback, useMemo, useRef, useState } from 'react'
import { useT } from '@memry/i18n/renderer'
import { useReducedMotion } from 'motion/react'
import {
  DndContext,
  DragOverlay,
  KeyboardCode,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  defaultDropAnimationSideEffects,
  pointerWithin,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type DropAnimation
} from '@dnd-kit/core'
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy
} from '@dnd-kit/sortable'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Search } from '@/lib/icons'
import { useTagCategories, type HubTag } from '@/hooks/use-tag-categories'
import { useSidebarNavigation } from '@/hooks/use-sidebar-navigation'
import { CategoryBlock, CategoryDragChip } from '@/components/tags-hub/category-block'
import { TagChipContent } from '@/components/tags-hub/tag-chip-item'
import { InlineCreateRow } from '@/components/tags-hub/inline-create-row'
import { moveCategory, applyCategoryOrder, type HubState } from '@/components/tags-hub/reorder'
import {
  beginTagDrag,
  commitTagMove,
  previewContainerMove,
  resolveTagDrop,
  type OverTarget,
  type TagDragSession
} from '@/components/tags-hub/drag-session'
import { filterHub } from '@/components/tags-hub/filter'

// Space picks up/drops a drag; Enter is left alone so focusing a chip and
// pressing Enter still opens it instead of starting a drag (dnd-kit's
// default `keyboardCodes` treats Enter the same as Space).
const keyboardCodes = {
  start: [KeyboardCode.Space],
  cancel: [KeyboardCode.Esc],
  end: [KeyboardCode.Space]
}

/**
 * Scopes collision detection to droppables the current drag can actually
 * accept, then prefers the pointer's own hit over nearest-neighbour guessing.
 *
 * The hub mixes three kinds of droppable — category sections, per-category
 * tag containers, and the chips themselves — and an unscoped `closestCenter`
 * happily matches a category section while the pointer sits inside a tag
 * container, which `onDragEnd` then rejects. Scoping first means a category
 * drag only ever sees categories and a tag drag only ever sees chips and
 * containers.
 *
 * Within a tag drag, chips are ranked ahead of the container holding them, so
 * hovering a chip inserts at that chip's index instead of falling through to
 * "append to the end of the category".
 */
const hubCollisionDetection: CollisionDetection = (args) => {
  const activeType = args.active.data.current?.type
  const droppableContainers = args.droppableContainers.filter((container) => {
    const type = container.data.current?.type
    return activeType === 'category'
      ? type === 'category'
      : type === 'tag' || type === 'tag-container'
  })

  const scoped = { ...args, droppableContainers }
  const pointerHits = pointerWithin(scoped)
  const collisions = pointerHits.length > 0 ? pointerHits : closestCorners(scoped)
  if (activeType === 'category') return collisions

  const typeById = new Map(droppableContainers.map((c) => [c.id, c.data.current?.type]))
  return [...collisions].sort(
    (a, b) => (typeById.get(a.id) === 'tag' ? 0 : 1) - (typeById.get(b.id) === 'tag' ? 0 : 1)
  )
}

type ActiveDrag = { kind: 'tag'; tag: HubTag } | { kind: 'category'; name: string; count: number }

function findHubTag(state: HubState, tag: string): HubTag | null {
  return (
    state.uncategorized.find((t) => t.tag === tag) ??
    state.categories.flatMap((c) => c.tags).find((t) => t.tag === tag) ??
    null
  )
}

export function TagsHubPage(): React.JSX.Element {
  const { t } = useT('notes')
  const {
    categories,
    uncategorized,
    isLoading,
    error,
    createCategory,
    renameCategory,
    deleteCategory,
    createTag,
    reorder
  } = useTagCategories()
  const { openSidebarItem } = useSidebarNavigation()
  const reduceMotion = useReducedMotion()

  // What the list actually renders, standing in for the hook's data in two
  // consecutive phases of the same gesture: the live preview while a tag is
  // being dragged (so it can be seen landing before the pointer is released),
  // then the optimistic result while `reorder()` round-trips through IPC.
  // Cleared once that settles — on success the hook has already refetched the
  // real order, on failure the real, unchanged order takes back over.
  const [override, setOverride] = useState<HubState | null>(null)
  // `onDragEnd` needs the last preview `onDragOver` produced, and reading it
  // from `override` would race the render that applied it. The ref is the
  // authority; the state exists to trigger the render.
  const overrideRef = useRef<HubState | null>(null)
  const applyOverride = useCallback((next: HubState | null): void => {
    overrideRef.current = next
    setOverride(next)
  }, [])

  const dragSessionRef = useRef<TagDragSession | null>(null)
  const [activeDrag, setActiveDrag] = useState<ActiveDrag | null>(null)

  const [query, setQuery] = useState('')
  const isSearching = query.trim().length > 0

  const displayCategories = override?.categories ?? categories
  const displayUncategorized = override?.uncategorized ?? uncategorized

  const filtered = useMemo(
    () => filterHub({ categories: displayCategories, uncategorized: displayUncategorized }, query),
    [displayCategories, displayUncategorized, query]
  )
  const filteredCategories = filtered.categories
  const filteredUncategorized = filtered.uncategorized
  const hasResults = filteredCategories.length > 0 || filteredUncategorized.length > 0

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 5
      }
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
      keyboardCodes
    })
  )
  // A search query narrows the visible list to a subset — dragging within it
  // would make `reorder()` renumber sort orders against that subset, not the
  // real full list, corrupting order for anything filtered out of view. No
  // sensor means dnd-kit can't start a drag at all, and `handleDragEnd` bails
  // before touching `reorder()` even if a drag end event arrived some other
  // way.
  const activeSensors = isSearching ? [] : sensors

  const categoryIds = useMemo(() => filteredCategories.map((c) => c.id), [filteredCategories])

  // The overlay is the only thing that follows the cursor. Its default drop
  // animation flies the ghost into the node it is replacing — which, because
  // the preview has already relocated the chip, is the slot at the
  // destination rather than the chip's original home.
  const dropAnimation: DropAnimation | null = reduceMotion
    ? null
    : {
        duration: 180,
        easing: 'ease-out',
        sideEffects: defaultDropAnimationSideEffects({ styles: { active: { opacity: '0.4' } } })
      }

  const handleTagOpen = (tag: string): void => {
    openSidebarItem({ type: 'tag', title: tag, path: '/tags/' + tag, entityId: tag })
  }

  const handleDragStart = useCallback(
    (event: DragStartEvent): void => {
      const activeData = event.active.data.current as { type?: string } | undefined
      const snapshot: HubState = {
        categories: displayCategories,
        uncategorized: displayUncategorized
      }

      if (activeData?.type === 'tag') {
        const tagName = String(event.active.id)
        const hubTag = findHubTag(snapshot, tagName)
        if (!hubTag) return
        dragSessionRef.current = beginTagDrag(snapshot, tagName)
        setActiveDrag({ kind: 'tag', tag: hubTag })
        // Seed the preview with the pre-drag arrangement so every later
        // `onDragOver` has a base to move the tag within.
        applyOverride(snapshot)
        return
      }

      if (activeData?.type === 'category') {
        const category = displayCategories.find((c) => c.id === event.active.id)
        if (!category) return
        setActiveDrag({ kind: 'category', name: category.name, count: category.tags.length })
      }
    },
    [displayCategories, displayUncategorized, applyOverride]
  )

  // Tag drags preview as they go: the chip is moved into whatever category the
  // pointer is over, so the user watches it land instead of guessing. Only the
  // change of category is written to state — `previewContainerMove` explains
  // why previewing position *within* a category loops forever. Category drags
  // are left alone entirely; `verticalListSortingStrategy` already displaces
  // their neighbours, and moving them in state as well would fight it.
  const handleDragOver = useCallback(
    (event: DragOverEvent): void => {
      const session = dragSessionRef.current
      if (!session || !event.over) return

      const overData = event.over.data.current as OverTarget | undefined
      if (!overData || (overData.type !== 'tag' && overData.type !== 'tag-container')) return

      const base = overrideRef.current ?? session.snapshot
      const next = previewContainerMove(base, session.tag, overData)
      if (next) applyOverride(next)
    },
    [applyOverride]
  )

  const handleDragCancel = useCallback((): void => {
    dragSessionRef.current = null
    setActiveDrag(null)
    applyOverride(null)
  }, [applyOverride])

  const handleDragEnd = useCallback(
    (event: DragEndEvent): void => {
      const session = dragSessionRef.current
      dragSessionRef.current = null
      setActiveDrag(null)

      // Belt-and-suspenders alongside `activeSensors`: even if a drag end
      // event arrives while a query is active, never let it reach
      // `reorder()` — reordering a filtered view would write sort orders
      // that don't reflect the real, unfiltered order.
      if (isSearching) {
        applyOverride(null)
        return
      }

      const activeData = event.active.data.current as { type?: string } | undefined

      if (activeData?.type === 'category') {
        const overData = event.over?.data.current as { type?: string } | undefined
        if (!event.over || overData?.type !== 'category') {
          applyOverride(null)
          return
        }

        const fromIndex = displayCategories.findIndex((c) => c.id === event.active.id)
        const toIndex = displayCategories.findIndex((c) => c.id === event.over?.id)
        if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex) {
          applyOverride(null)
          return
        }

        const result = moveCategory(displayCategories, fromIndex, toIndex)
        if (result.length === 0) {
          applyOverride(null)
          return
        }

        applyOverride({
          categories: applyCategoryOrder(displayCategories, result),
          uncategorized: displayUncategorized
        })
        void reorder({ categories: result }).finally(() => applyOverride(null))
        return
      }

      // Tag drag. Normally the preview already holds the final arrangement
      // and only has to be turned into persisted assignments, computed
      // against the session's pre-drag snapshot — see `drag-session.ts` for
      // why the preview must not itself be the input. When the drag ended
      // before any `onDragOver` ran, there is no preview to read and the
      // final collision is resolved directly instead.
      const preview = overrideRef.current
      const overData = event.over?.data.current as OverTarget | undefined
      const isTagTarget = overData && (overData.type === 'tag' || overData.type === 'tag-container')
      const assignments =
        session && preview
          ? commitTagMove(session, preview, isTagTarget ? overData : undefined)
          : isTagTarget
            ? resolveTagDrop(
                { categories: displayCategories, uncategorized: displayUncategorized },
                String(event.active.id),
                overData
              )
            : []

      if (assignments.length === 0) {
        applyOverride(null)
        return
      }

      // The preview stays on screen as the optimistic state until the write
      // settles, so nothing snaps back mid-flight.
      void reorder({ tags: assignments }).finally(() => applyOverride(null))
    },
    [isSearching, displayCategories, displayUncategorized, reorder, applyOverride]
  )

  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Escape') setQuery('')
  }

  if (error) {
    return <div className="p-6 text-sm text-destructive">{error}</div>
  }

  return (
    <ScrollArea className="h-full">
      {/* Full-bleed, not a centred measure: the column spans the window so
          section rules run the full width, while the content inside it stays
          on the start edge. Vertical rhythm comes from each section's own
          `border-t py-[22px]`, so this column deliberately has no `gap`. The
          leading section drops its rule (`isFirst`) so the list starts
          directly under the action bar instead of behind a stray divider. */}
      <div className="flex w-full flex-col px-10 pt-6 pb-10">
        {isLoading ? (
          <div className="text-sm text-muted-foreground">{t('tagsHub.loading')}</div>
        ) : (
          <>
            <DndContext
              sensors={activeSensors}
              collisionDetection={hubCollisionDetection}
              onDragStart={handleDragStart}
              onDragOver={handleDragOver}
              onDragCancel={handleDragCancel}
              onDragEnd={handleDragEnd}
            >
              {/* One action bar leads the page: create affordances and search
                  sit together, above the list, so both stay reachable without
                  scrolling past every category. `items-start` keeps the search
                  field pinned to the top row when the create affordance
                  expands into a name input plus colour palette. */}
              <div className="flex items-start gap-2 pb-[22px]">
                <InlineCreateRow onCreateCategory={createCategory} onCreateTag={createTag} />
                <div className="relative shrink-0">
                  <Search className="pointer-events-none absolute start-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                  {/* Chromeless until it matters: nothing but the icon and
                      placeholder on the page background, earning a hairline
                      only while focused. The border is always there but
                      transparent, so gaining it shifts nothing; `border-ring`
                      is a neutral grey, so focus stays perceivable without
                      shouting. */}
                  <input
                    type="text"
                    aria-label={t('tagsHub.search.placeholder')}
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={handleSearchKeyDown}
                    placeholder={t('tagsHub.search.placeholder')}
                    className="h-8 w-[240px] rounded-md border border-transparent bg-transparent ps-8 pe-2.5 text-xs placeholder:text-muted-foreground transition-colors focus:border-ring focus:outline-none"
                  />
                </div>
              </div>
              {isSearching && !hasResults ? (
                <div className="border-t border-border py-[22px] text-sm text-muted-foreground">
                  {t('tagsHub.search.empty')}
                </div>
              ) : (
                <>
                  <SortableContext items={categoryIds} strategy={verticalListSortingStrategy}>
                    {filteredCategories.map((category, index) => (
                      <CategoryBlock
                        key={category.id}
                        id={category.id}
                        name={category.name}
                        tags={category.tags}
                        isFirst={index === 0}
                        onTagOpen={handleTagOpen}
                        onRename={(newName) => renameCategory(category.id, newName)}
                        onDelete={() => deleteCategory(category.id)}
                      />
                    ))}
                  </SortableContext>
                  {(!isSearching || filteredUncategorized.length > 0) && (
                    <CategoryBlock
                      id={null}
                      name={t('tagsHub.uncategorized')}
                      tags={filteredUncategorized}
                      isFirst={filteredCategories.length === 0}
                      onTagOpen={handleTagOpen}
                    />
                  )}
                </>
              )}
              {/* The lifted ghost: a calm 5% scale and a shadow, no tilt —
                  a tag chip is small enough that rotation reads as novelty
                  rather than weight. */}
              <DragOverlay dropAnimation={dropAnimation}>
                {activeDrag?.kind === 'tag' ? (
                  <TagChipContent tag={activeDrag.tag} className="scale-105 shadow-lg" />
                ) : activeDrag?.kind === 'category' ? (
                  <CategoryDragChip name={activeDrag.name} count={activeDrag.count} />
                ) : null}
              </DragOverlay>
            </DndContext>
          </>
        )}
      </div>
    </ScrollArea>
  )
}

export default TagsHubPage
