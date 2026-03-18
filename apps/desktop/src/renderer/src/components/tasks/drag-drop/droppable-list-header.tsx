import type React from 'react'
import { useDroppable } from '@dnd-kit/core'

import { cn } from '@/lib/utils'
import { useDragContext } from '@/contexts/drag-context'

interface DroppableListHeaderProps {
  id: string
  label: string
  columnId?: string
  sectionId?: string
  sectionTaskIds?: string[]
  children: React.ReactNode
  className?: string
}

export const DroppableListHeader = ({
  id,
  label,
  columnId,
  sectionId,
  sectionTaskIds,
  children,
  className
}: DroppableListHeaderProps): React.JSX.Element => {
  const { dragState } = useDragContext()
  const isEnabled = Boolean(columnId)

  const { setNodeRef, isOver } = useDroppable({
    id,
    disabled: !isEnabled,
    data: isEnabled
      ? {
          type: 'column',
          columnId,
          sectionId,
          sectionTaskIds,
          column: { title: label }
        }
      : undefined
  })

  const isActiveDropTarget =
    isEnabled && dragState.isDragging && isOver && dragState.sourceContainerId !== sectionId

  return (
    <div
      ref={isEnabled ? setNodeRef : undefined}
      className={cn(
        'relative',
        isActiveDropTarget && 'rounded-md ring-2 ring-primary/25',
        className
      )}
      data-testid={isActiveDropTarget ? 'list-drop-indicator' : undefined}
      data-drop-indicator={isActiveDropTarget ? 'column' : undefined}
    >
      {children}
      {isActiveDropTarget && (
        <div
          className="absolute inset-x-6 bottom-0 h-0.5 rounded-full bg-primary/80 pointer-events-none"
          aria-hidden="true"
        />
      )}
    </div>
  )
}

export default DroppableListHeader
