/**
 * Split Drop Zones Container
 * Overlay with drop zones for drag-to-split functionality
 */

import { DropZone } from './drop-zone'

interface SplitDropZonesProps {
  /** Group ID for this pane */
  groupId: string
  /** Whether drop zones are active (tab being dragged) */
  isActive: boolean
}

/**
 * Container for all drop zones in a pane
 */
export const SplitDropZones = ({
  groupId,
  isActive
}: SplitDropZonesProps): React.JSX.Element | null => {
  if (!isActive) return null

  return (
    <div className="absolute inset-0 pointer-events-none z-50">
      {/* Left zone - 25% width */}
      <DropZone zone="left" groupId={groupId} className="absolute left-0 top-0 bottom-0 w-1/4" />

      {/* Right zone - 25% width */}
      <DropZone zone="right" groupId={groupId} className="absolute right-0 top-0 bottom-0 w-1/4" />

      {/* Center zone - move to this group without splitting */}
      <DropZone
        zone="center"
        groupId={groupId}
        className="absolute top-0 bottom-0 left-1/4 right-1/4"
      />
    </div>
  )
}

export default SplitDropZones
