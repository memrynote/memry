import * as React from 'react'
import { useCallback, useMemo, useState } from 'react'
import { useT } from '@memry/i18n/renderer'
import {
  DndContext,
  KeyboardCode,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent
} from '@dnd-kit/core'
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy
} from '@dnd-kit/sortable'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Search } from '@/lib/icons'
import { useTagCategories, type HubCategory, type HubTag } from '@/hooks/use-tag-categories'
import { useSidebarNavigation } from '@/hooks/use-sidebar-navigation'
import { CategoryBlock } from '@/components/tags-hub/category-block'
import { InlineCreateRow } from '@/components/tags-hub/inline-create-row'
import {
  moveCategory,
  moveTag,
  applyCategoryOrder,
  applyTagAssignments,
  type HubState
} from '@/components/tags-hub/reorder'
import { filterHub } from '@/components/tags-hub/filter'

// Space picks up/drops a drag; Enter is left alone so focusing a chip and
// pressing Enter still opens it instead of starting a drag (dnd-kit's
// default `keyboardCodes` treats Enter the same as Space).
const keyboardCodes = {
  start: [KeyboardCode.Space],
  cancel: [KeyboardCode.Esc],
  end: [KeyboardCode.Space]
}

interface OptimisticState {
  categories: HubCategory[]
  uncategorized: HubTag[]
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

  // Applied immediately on drop so the chip/block doesn't snap back while
  // `reorder()` round-trips through IPC; cleared once that settles (on
  // success the hook has already refetched the real order, on failure the
  // real, unchanged order takes back over — either way this stops lying).
  const [optimistic, setOptimistic] = useState<OptimisticState | null>(null)
  const [query, setQuery] = useState('')
  const isSearching = query.trim().length > 0

  const displayCategories = optimistic?.categories ?? categories
  const displayUncategorized = optimistic?.uncategorized ?? uncategorized

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

  const handleTagOpen = (tag: string): void => {
    openSidebarItem({ type: 'tag', title: tag, path: '/tags/' + tag, entityId: tag })
  }

  const handleDragEnd = useCallback(
    (event: DragEndEvent): void => {
      // Belt-and-suspenders alongside `activeSensors`: even if a drag end
      // event arrives while a query is active, never let it reach
      // `reorder()` — reordering a filtered view would write sort orders
      // that don't reflect the real, unfiltered order.
      if (isSearching) return

      const { active, over } = event
      if (!over) return

      const activeData = active.data.current as
        | { type: 'category'; categoryId: string | null }
        | { type: 'tag'; categoryId: string | null }
        | undefined
      if (!activeData) return

      if (activeData.type === 'category') {
        const overData = over.data.current as { type?: string } | undefined
        if (overData?.type !== 'category') return

        const fromIndex = displayCategories.findIndex((c) => c.id === active.id)
        const toIndex = displayCategories.findIndex((c) => c.id === over.id)
        if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex) return

        const result = moveCategory(displayCategories, fromIndex, toIndex)
        if (result.length === 0) return

        setOptimistic({
          categories: applyCategoryOrder(displayCategories, result),
          uncategorized: displayUncategorized
        })
        void reorder({ categories: result }).finally(() => setOptimistic(null))
        return
      }

      // Tag drag: dropped either on another chip (insert at that chip's
      // index within its category) or on a category's tag-container (an
      // empty category, or blank space past the last chip — append to end).
      const tag = String(active.id)
      const overData = over.data.current as
        | { type: 'tag'; tag: string; categoryId: string | null }
        | { type: 'tag-container'; categoryId: string | null }
        | undefined
      if (!overData) return

      const targetTagsFor = (categoryId: string | null): HubTag[] =>
        categoryId === null
          ? displayUncategorized
          : (displayCategories.find((c) => c.id === categoryId)?.tags ?? [])

      let toCategoryId: string | null
      let toIndex: number

      if (overData.type === 'tag') {
        toCategoryId = overData.categoryId
        const targetTags = targetTagsFor(toCategoryId)
        const overIndex = targetTags.findIndex((t) => t.tag === overData.tag)
        toIndex = overIndex === -1 ? targetTags.length : overIndex
      } else if (overData.type === 'tag-container') {
        toCategoryId = overData.categoryId
        toIndex = targetTagsFor(toCategoryId).length
      } else {
        return
      }

      const state: HubState = { categories: displayCategories, uncategorized: displayUncategorized }
      const result = moveTag(state, tag, toCategoryId, toIndex)
      if (result.length === 0) return

      setOptimistic(applyTagAssignments(displayCategories, displayUncategorized, result))
      void reorder({ tags: result }).finally(() => setOptimistic(null))
    },
    [isSearching, displayCategories, displayUncategorized, reorder]
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
          left-aligned. Vertical rhythm comes from each section's own
          `border-t py-[22px]`, so this column deliberately has no `gap`. */}
      <div className="flex w-full flex-col px-10 pt-6 pb-10">
        {isLoading ? (
          <div className="text-sm text-muted-foreground">{t('tagsHub.loading')}</div>
        ) : (
          <>
            <DndContext
              sensors={activeSensors}
              collisionDetection={closestCenter}
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
                    {filteredCategories.map((category) => (
                      <CategoryBlock
                        key={category.id}
                        id={category.id}
                        name={category.name}
                        tags={category.tags}
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
                      onTagOpen={handleTagOpen}
                    />
                  )}
                </>
              )}
            </DndContext>
          </>
        )}
      </div>
    </ScrollArea>
  )
}

export default TagsHubPage
