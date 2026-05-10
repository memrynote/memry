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
      <DropZone zone="left" groupId={groupId} className="absolute start-0 inset-y-0 w-1/4" />

      {/* Right zone - 25% width */}
      <DropZone zone="right" groupId={groupId} className="absolute end-0 inset-y-0 w-1/4" />

      {/* Top zone - 25% height */}
      <DropZone zone="top" groupId={groupId} className="absolute top-0 start-1/4 end-1/4 h-1/4" />

      {/* Bottom zone - 25% height */}
      <DropZone
        zone="bottom"
        groupId={groupId}
        className="absolute bottom-0 start-1/4 end-1/4 h-1/4"
      />

      {/* Center zone - move to this group without splitting */}
      <DropZone
        zone="center"
        groupId={groupId}
        className="absolute top-1/4 bottom-1/4 start-1/4 end-1/4"
      />
    </div>
  )
}

export default SplitDropZones
