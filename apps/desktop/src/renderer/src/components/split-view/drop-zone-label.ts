import type { DropZonePosition } from './drop-zone'

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
