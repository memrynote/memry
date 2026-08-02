import * as React from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useT } from '@memry/i18n/renderer'
import { useDroppable } from '@dnd-kit/core'
import { useSortable, SortableContext, rectSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { GripVertical, MoreHorizontal, Pencil, Trash } from '@/lib/icons'
import { TagChipItem } from '@/components/tags-hub/tag-chip-item'
import { cn } from '@/lib/utils'
import type { HubTag } from '@/hooks/use-tag-categories'

/** Stable sortable id for the Uncategorized block, which never reorders. */
const UNCATEGORIZED_SORTABLE_ID = '__uncategorized__'

/**
 * Classes for a category's tag row, which doubles as its drop zone.
 *
 * Split out of the component because `isOver` only flips during a live
 * pointer drag, which jsdom can't drive — as a pure function the branch is
 * directly assertable (`category-drop-zone.test.ts`).
 *
 * A populated row used to get no hover treatment at all (the highlight was
 * gated on the category being empty), so dragging a tag onto a category that
 * already had chips gave no signal about where it would land. Both states
 * now respond. The populated row's padding is cancelled by a matching
 * negative margin so gaining the highlight box shifts no chip.
 */
export function tagDropZoneClasses({
  isOver,
  isEmpty
}: {
  isOver: boolean
  isEmpty: boolean
}): string {
  if (isEmpty) {
    return cn(
      'rounded-lg border border-dashed py-2.5 ps-3 text-start text-xs transition-colors',
      isOver
        ? 'border-primary/50 bg-primary/5 text-primary'
        : 'border-border text-muted-foreground/80'
    )
  }
  return cn(
    '-m-1 flex flex-wrap gap-2 rounded-lg border border-transparent p-1 transition-colors',
    isOver && 'border-primary/30 bg-primary/5'
  )
}

/**
 * The compact stand-in a category becomes while being dragged, rendered by
 * the page's `DragOverlay`. Deliberately not the whole section: a wide
 * category would otherwise lift a ghost covering half the window, which
 * fights the hub's calm register. Name and count are enough to say what is
 * being moved.
 */
export function CategoryDragChip({
  name,
  count
}: {
  name: string
  count: number
}): React.JSX.Element {
  return (
    <div className="flex h-8 items-center gap-2 rounded-lg border border-border bg-popover ps-2 pe-3 shadow-lg">
      <GripVertical className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
      <span className="text-[13px] font-medium leading-[18px] tracking-[-0.005em] text-foreground">
        {name}
      </span>
      <span className="text-xs tabular-nums text-muted-foreground/70">{count}</span>
    </div>
  )
}

export interface CategoryBlockProps {
  id: string | null
  name: string
  tags: HubTag[]
  /** Drops this block's top rule — the rules separate blocks, so the block
      leading the list gets none and sits directly under the action bar. */
  isFirst?: boolean
  onTagOpen(tag: string): void
  onRename?(name: string): void
  onDelete?(): void
}

/**
 * One category section in the tag hub: a heading (name + tag count, plus a
 * hover-revealed `⋯` menu carrying rename/delete for real categories)
 * followed by a wrapping row of tag chips. The menu sits directly after the
 * count rather than at the far end of the row, so the whole heading stays
 * one compact cluster on the left lane. `id === null` is the Uncategorized
 * block, which has no menu — and, since it isn't a real category, no drag
 * handle either (it never participates in category reordering).
 *
 * Rename swaps the heading for an inline input (matching the create
 * affordance): Enter commits the trimmed name, Escape reverts. Delete opens
 * the app's `AlertDialog` — its body calls out that tags survive the delete
 * and move to Uncategorized, since that isn't obvious from "Delete".
 *
 * Drag and drop: the block itself is a dnd-kit sortable (category
 * reordering, drag handle only — the heading/rename/delete stay click-only)
 * and its tag row is both a `useDroppable` container (so an empty category
 * can still receive a dropped tag) and a nested `SortableContext` using
 * `rectSortingStrategy` (chips wrap, unlike the vertical list of blocks).
 */
export function CategoryBlock({
  id,
  name,
  tags,
  isFirst = false,
  onTagOpen,
  onRename,
  onDelete
}: CategoryBlockProps): React.JSX.Element {
  const { t } = useT('notes')
  const [isRenaming, setIsRenaming] = useState(false)
  const [draftName, setDraftName] = useState(name)
  const [isDeleteOpen, setIsDeleteOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const {
    attributes,
    listeners,
    setNodeRef: setSortableNodeRef,
    transform,
    transition,
    isDragging
  } = useSortable({
    id: id ?? UNCATEGORIZED_SORTABLE_ID,
    disabled: id === null,
    data: { type: 'category' as const, categoryId: id }
  })

  const { setNodeRef: setDroppableNodeRef, isOver } = useDroppable({
    id: `tag-container-${id ?? 'uncategorized'}`,
    data: { type: 'tag-container' as const, categoryId: id }
  })

  const sectionStyle: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition
  }

  const tagIds = useMemo(() => tags.map((t) => t.tag), [tags])

  useEffect(() => {
    if (isRenaming) {
      inputRef.current?.focus()
    }
  }, [isRenaming])

  const startRename = (): void => {
    setDraftName(name)
    setIsRenaming(true)
  }

  const commitRename = (): void => {
    const trimmed = draftName.trim()
    if (trimmed) {
      onRename?.(trimmed)
    }
    setIsRenaming(false)
  }

  const cancelRename = (): void => {
    setDraftName(name)
    setIsRenaming(false)
  }

  const handleRenameKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') {
      event.preventDefault()
      commitRename()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      cancelRename()
    }
  }

  const handleConfirmDelete = (): void => {
    onDelete?.()
    setIsDeleteOpen(false)
  }

  return (
    <section
      ref={setSortableNodeRef}
      style={sectionStyle}
      className={cn(
        'flex flex-col gap-[11px] py-[22px]',
        !isFirst && 'border-t border-border',
        isDragging && 'opacity-50'
      )}
    >
      {/* The 24px handle slot + 4px gap is cancelled by `-ms-7`, so the
          heading text lands on the same left lane as the chips below it
          while the handle itself hangs in the page gutter. The slot is
          rendered even for Uncategorized (which has no handle) so both
          headings still start at that lane. */}
      <div className="group -ms-7 flex items-center gap-1">
        <div className="flex h-6 w-6 shrink-0 items-center justify-center">
          {id !== null && (
            <button
              type="button"
              aria-label={t('tagsHub.category.dragHandle')}
              className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground/50 opacity-0 transition-opacity hover:text-muted-foreground group-hover:opacity-100 cursor-grab active:cursor-grabbing"
              {...attributes}
              {...listeners}
            >
              <GripVertical className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        {isRenaming ? (
          <Input
            ref={inputRef}
            value={draftName}
            onChange={(event) => setDraftName(event.target.value)}
            onKeyDown={handleRenameKeyDown}
            className="h-7 w-48"
          />
        ) : (
          <h3
            className={cn(
              'text-[13px] font-medium leading-[18px] tracking-[-0.005em]',
              id === null ? 'text-muted-foreground' : 'text-foreground'
            )}
          >
            {name}
          </h3>
        )}
        <span className="ms-1.5 text-xs text-muted-foreground/70 tabular-nums">{tags.length}</span>
        {id !== null && !isRenaming && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="ms-1 h-6 w-6 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 data-[state=open]:opacity-100"
                aria-label={t('tagsHub.category.more')}
              >
                <MoreHorizontal className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-44">
              <DropdownMenuItem onClick={startRename}>
                <Pencil className="me-2 h-3.5 w-3.5" />
                {t('tagsHub.category.rename')}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => setIsDeleteOpen(true)}
                className="text-destructive focus:text-destructive"
              >
                <Trash className="me-2 h-3.5 w-3.5" />
                {t('tagsHub.category.delete')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {id !== null && (
        <AlertDialog open={isDeleteOpen} onOpenChange={setIsDeleteOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t('tagsHub.category.deleteTitle', { name })}</AlertDialogTitle>
              <AlertDialogDescription>{t('tagsHub.category.deleteBody')}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t('tagsHub.category.deleteCancel')}</AlertDialogCancel>
              <AlertDialogAction onClick={handleConfirmDelete}>
                {t('tagsHub.category.deleteConfirm')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}

      <SortableContext items={tagIds} strategy={rectSortingStrategy}>
        <div
          ref={setDroppableNodeRef}
          className={tagDropZoneClasses({ isOver, isEmpty: tags.length === 0 })}
        >
          {tags.length === 0
            ? t('tagsHub.category.emptyHint')
            : tags.map((tag) => (
                <TagChipItem
                  key={tag.tag}
                  tag={tag}
                  categoryId={id}
                  onOpen={() => onTagOpen(tag.tag)}
                />
              ))}
        </div>
      </SortableContext>
    </section>
  )
}

export default CategoryBlock
