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

  const displayCategories = optimistic?.categories ?? categories
  const displayUncategorized = optimistic?.uncategorized ?? uncategorized

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

  const categoryIds = useMemo(() => displayCategories.map((c) => c.id), [displayCategories])

  const handleTagOpen = (tag: string): void => {
    openSidebarItem({ type: 'tag', title: tag, path: '/tags/' + tag, entityId: tag })
  }

  const handleDragEnd = useCallback(
    (event: DragEndEvent): void => {
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
    [displayCategories, displayUncategorized, reorder]
  )

  if (error) {
    return <div className="p-6 text-sm text-destructive">{error}</div>
  }

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-6 py-6">
        {isLoading ? (
          <div className="text-sm text-muted-foreground">{t('tagsHub.loading')}</div>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext items={categoryIds} strategy={verticalListSortingStrategy}>
              {displayCategories.map((category) => (
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
            <CategoryBlock
              id={null}
              name={t('tagsHub.uncategorized')}
              tags={displayUncategorized}
              onTagOpen={handleTagOpen}
            />
            <InlineCreateRow onCreateCategory={createCategory} onCreateTag={createTag} />
          </DndContext>
        )}
      </div>
    </ScrollArea>
  )
}

export default TagsHubPage
