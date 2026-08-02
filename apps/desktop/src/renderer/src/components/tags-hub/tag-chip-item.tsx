import * as React from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { getTagColors } from '@/components/note/tags-row/tag-colors'
import { NoteIconDisplay } from '@/lib/render-note-icon'
import { cn } from '@/lib/utils'
import type { HubTag } from '@/hooks/use-tag-categories'

export interface TagChipContentProps {
  tag: HubTag
  className?: string
}

/**
 * The chip's visuals, carrying no dnd-kit hooks of their own. `TagChipItem`
 * wraps this for the page; `DragOverlay` renders it directly, so the ghost
 * under the cursor is the chip itself rather than a lookalike that can drift
 * out of sync. Same split as `KanbanCardContent` / `KanbanDragOverlay`.
 *
 * Keeps the sidebar's color model (`sidebar-tag-list.tsx`: `getTagColors`
 * driving both fill and text) but carries the hub's own chip geometry —
 * taller, softer corners, and a leading `#` in place of the sidebar's dot,
 * so a wrapping field of chips reads as tags rather than as status pills.
 * Always shows the full tag name (never just the leaf segment) and always
 * shows the item count.
 */
export function TagChipContent({ tag, className }: TagChipContentProps): React.JSX.Element {
  const colors = getTagColors(tag.color, tag.tag)

  return (
    <span
      style={{ backgroundColor: `${colors.text}1F`, color: colors.text }}
      className={cn(
        'flex h-7 min-w-0 items-center gap-1.5 rounded-[7px] ps-[9px] pe-2.5 text-[13px] font-medium leading-4',
        className
      )}
    >
      {tag.icon ? (
        <NoteIconDisplay value={tag.icon} className="size-3.5 shrink-0 text-xs leading-none" />
      ) : (
        <span aria-hidden className="shrink-0 opacity-60">
          #
        </span>
      )}
      <span className="min-w-0 truncate">{tag.tag}</span>
      <span className="text-[11px] tabular-nums opacity-55">{tag.count}</span>
    </span>
  )
}

export interface TagChipItemProps {
  tag: HubTag
  /** The category this chip currently belongs to (null = uncategorized). */
  categoryId: string | null
  onOpen(): void
}

/**
 * One tag chip in the tag hub, as a dnd-kit sortable item: the whole chip is
 * both the click target (open the tag) and the drag handle, the same pattern
 * as `kanban-card.tsx` — a short pointer press opens it, a 5px+ drag moves
 * it (see the PointerSensor `distance` activation constraint configured on
 * the page). Keyboard drag uses Space/arrow/Space rather than Enter/Space so
 * focusing a chip and pressing Enter still opens it (see the page's
 * `KeyboardSensor` `keyboardCodes` override).
 *
 * While a drag is in flight the page has already previewed this chip into
 * the bucket it is hovering, so this node is the placeholder sitting at the
 * destination. It recedes rather than disappearing, which is what gives the
 * drag its "slot opened here" reading — the opaque copy under the cursor is
 * the `DragOverlay`.
 */
export function TagChipItem({ tag, categoryId, onOpen }: TagChipItemProps): React.JSX.Element {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: tag.tag,
    data: { type: 'tag' as const, tag: tag.tag, categoryId }
  })

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition
  }

  return (
    <button
      ref={setNodeRef}
      style={style}
      type="button"
      onClick={onOpen}
      title={`${tag.tag} (${tag.count})`}
      className={cn(
        'flex min-w-0 cursor-grab rounded-[7px] active:cursor-grabbing',
        isDragging && 'opacity-40'
      )}
      {...attributes}
      {...listeners}
    >
      <TagChipContent tag={tag} />
    </button>
  )
}

export default TagChipItem
