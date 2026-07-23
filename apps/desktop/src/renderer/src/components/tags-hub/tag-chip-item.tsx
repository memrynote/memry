import * as React from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { getTagColors } from '@/components/note/tags-row/tag-colors'
import { NoteIconDisplay } from '@/lib/render-note-icon'
import { cn } from '@/lib/utils'
import type { HubTag } from '@/hooks/use-tag-categories'

export interface TagChipItemProps {
  tag: HubTag
  /** The category this chip currently belongs to (null = uncategorized). */
  categoryId: string | null
  onOpen(): void
}

/**
 * One tag chip in the tag hub. Reuses the sidebar's chip visual language
 * (`sidebar-tag-list.tsx` ~151-183: `getTagColors`, `${colors.text}1A` fill,
 * icon-or-dot leading slot) but always shows the full tag name (never just
 * the leaf segment) and always shows the item count.
 *
 * Also a dnd-kit sortable item: the whole chip is both the click target
 * (open the tag) and the drag handle, the same pattern as
 * `kanban-card.tsx` — a short pointer press opens it, a 5px+ drag reorders
 * it (see the PointerSensor `distance` activation constraint configured on
 * the page). Keyboard drag uses Space/arrow/Space rather than Enter/Space
 * so focusing a chip and pressing Enter still opens it (see the page's
 * `KeyboardSensor` `keyboardCodes` override).
 */
export function TagChipItem({ tag, categoryId, onOpen }: TagChipItemProps): React.JSX.Element {
  const colors = getTagColors(tag.color, tag.tag)

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
      style={{ ...style, backgroundColor: `${colors.text}1A`, color: colors.text }}
      type="button"
      onClick={onOpen}
      title={`${tag.tag} (${tag.count})`}
      className={cn(
        'flex items-center gap-1.5 rounded-sm py-1 px-2 text-xs font-medium leading-4 min-w-0 cursor-grab active:cursor-grabbing',
        isDragging && 'opacity-50'
      )}
      {...attributes}
      {...listeners}
    >
      {tag.icon ? (
        <NoteIconDisplay value={tag.icon} className="size-3 shrink-0 text-xs leading-none" />
      ) : (
        <span className="size-1.5 rounded-full shrink-0" style={{ backgroundColor: colors.text }} />
      )}
      <span className="min-w-0 truncate">{tag.tag}</span>
      <span className="text-[10px] tabular-nums opacity-60">{tag.count}</span>
    </button>
  )
}

export default TagChipItem
