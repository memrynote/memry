import type React from 'react'
import { useDroppable } from '@dnd-kit/core'

import { cn } from '@/lib/utils'
import { useDragContext } from '@/contexts/drag-context'
import { getCrossSectionDropSpacerHeight, resolveSectionDragState } from './list-section-drag-state'
import { InsertionIndicator } from './insertion-indicator'

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

  const { setNodeRef } = useDroppable({
    id,
    disabled: !isEnabled,
    data: isEnabled
      ? {
          type: 'column',
          columnId,
          sectionId,
          sectionTaskIds,
          sectionDropPosition: 'start',
          column: { title: label }
        }
      : undefined
  })

  const sectionDragState = resolveSectionDragState(dragState, sectionId)
  const isTargetSection = sectionDragState === 'target-highlighted'
  const isSourceSection = sectionDragState === 'source-dimmed'
  const dropSpacerHeight = getCrossSectionDropSpacerHeight(dragState, sectionId)

  return (
    <div
      ref={isEnabled ? setNodeRef : undefined}
      className={cn(
        'relative transition-[padding] duration-150',
        isTargetSection && 'rounded-md border border-primary/25 bg-primary/[0.04]',
        isSourceSection && 'opacity-50',
        className
      )}
      style={dropSpacerHeight > 0 ? { paddingBottom: `${dropSpacerHeight}px` } : undefined}
      data-testid={isTargetSection ? 'list-drop-indicator' : undefined}
      data-drop-indicator={isTargetSection ? 'column' : undefined}
      data-drop-space={dropSpacerHeight > 0 ? String(dropSpacerHeight) : undefined}
      data-section-drag-state={sectionDragState}
    >
      {isTargetSection && dragState.sectionDropPosition === 'start' && (
        <InsertionIndicator
          position="after"
          className="left-3 right-3"
          dataTestId="list-drop-indicator"
          kind="column"
        />
      )}
      {children}
    </div>
  )
}

export default DroppableListHeader
