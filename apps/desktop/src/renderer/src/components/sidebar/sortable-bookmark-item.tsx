import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { SidebarMenuItem } from '@/components/ui/sidebar'
import { BOOKMARK_SORT_DRAG_TYPE } from './sidebar-drag-types'

interface SortableBookmarkItemProps {
  id: string
  /** Reordering only applies in the manual sort mode. */
  disabled: boolean
  children: React.ReactNode
}

/**
 * Drag-to-reorder wrapper for one bookmark row.
 *
 * The listeners sit on the row itself, matching SortableProjectItem — the row's
 * button still takes clicks because dnd-kit only starts a drag once the
 * pointer passes the activation constraint.
 */
export function SortableBookmarkItem({
  id,
  disabled,
  children
}: SortableBookmarkItemProps): React.JSX.Element {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
    disabled,
    data: { type: BOOKMARK_SORT_DRAG_TYPE }
  })

  return (
    <SidebarMenuItem
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={isDragging ? 'opacity-50' : undefined}
      {...attributes}
      {...listeners}
    >
      {children}
    </SidebarMenuItem>
  )
}
