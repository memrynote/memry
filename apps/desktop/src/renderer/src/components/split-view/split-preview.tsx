/**
 * Split Preview Component
 * Ghost preview of where the split will appear
 */

import type { DropZonePosition } from './drop-zone'
import { cn } from '@/lib/utils'

interface SplitPreviewProps {
  /** Active drop zone */
  zone: DropZonePosition | null
}

/**
 * Visual preview of split position
 */
export const SplitPreview = ({ zone }: SplitPreviewProps): React.JSX.Element | null => {
  if (!zone || zone === 'center') return null

  const getPreviewStyle = (): React.CSSProperties => {
    switch (zone) {
      case 'left':
        return { left: 0, top: 0, bottom: 0, width: '50%' }
      case 'right':
        return { right: 0, top: 0, bottom: 0, width: '50%' }
      case 'top':
        return { top: 0, left: 0, right: 0, height: '50%' }
      case 'bottom':
        return { bottom: 0, left: 0, right: 0, height: '50%' }
      default:
        return {}
    }
  }

  return (
    <div
      className={cn(
        'absolute pointer-events-none z-40',
        'bg-tint-lighter border-2 border-tint-border rounded-md',
        'transition-all duration-200'
      )}
      style={getPreviewStyle()}
    />
  )
}

export default SplitPreview
