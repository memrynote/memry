/**
 * Drop Zone Component
 * Individual drop zone for drag-to-split functionality
 */

import { useDroppable } from '@dnd-kit/core'
import { cn } from '@/lib/utils'

export type DropZonePosition = 'left' | 'right' | 'top' | 'bottom' | 'center'

interface DropZoneProps {
  /** Zone position */
  zone: DropZonePosition
  /** Group ID this zone belongs to */
  groupId: string
  /** CSS positioning classes */
  className: string
}

/**
 * Get label for drop zone
 */
export const getDropZoneLabel = (zone: DropZonePosition): string => {
  switch (zone) {
    case 'left':
      return 'Split Left'
    case 'right':
      return 'Split Right'
    case 'top':
      return 'Split Up'
    case 'bottom':
      return 'Split Down'
    case 'center':
      return 'Move Here'
  }
}

/**
 * Individual drop zone for drag-to-split
 */
export const DropZone = ({ zone, groupId, className }: DropZoneProps): React.JSX.Element => {
  const { isOver, setNodeRef } = useDroppable({
    id: `drop-${groupId}-${zone}`,
    data: {
      type: 'split-zone',
      zone,
      groupId
    }
  })

  return (
    <div
      ref={setNodeRef}
      className={cn(className, 'pointer-events-auto transition-all duration-150')}
    >
      {/* Visual indicator when hovering */}
      <div
        className={cn(
          'absolute inset-2 rounded-lg transition-all duration-150',
          isOver
            ? 'bg-blue-500/20 border-2 border-dashed border-blue-500'
            : 'bg-transparent border-2 border-transparent'
        )}
      >
        {/* Zone label */}
        {isOver && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="bg-blue-500 text-white px-3 py-1.5 rounded-md text-sm font-medium shadow-lg">
              {getDropZoneLabel(zone)}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export default DropZone
