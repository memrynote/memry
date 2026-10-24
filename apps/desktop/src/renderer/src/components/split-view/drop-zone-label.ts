import type { DropZonePosition } from './drop-zone'

/**
 * Get label for drop zone
 */
// oxlint-disable-next-line typescript/consistent-return -- exhaustive switch over a closed union; the implicit fallthrough is unreachable for typed input
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
