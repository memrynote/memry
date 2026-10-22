/**
 * Native Split Drop Zones
 * Drop zones for a sidebar row dragged into a pane. The sidebar trees use the
 * browser's own drag and drop, which dnd-kit (and so `SplitDropZones`) cannot see.
 */

import { useEffect, useState } from 'react'
import { useTabActions } from '@/contexts/tabs'
import { MEMRY_TAB_DRAG_MIME, readTabDragData } from '@/lib/drag-mime'
import { cn } from '@/lib/utils'
import type { DropZonePosition } from './drop-zone'
import { getDropZoneLabel } from './drop-zone-label'
import { SplitPreview } from './split-preview'

const hasTabPayload = (event: DragEvent | React.DragEvent): boolean =>
  event.dataTransfer?.types.includes(MEMRY_TAB_DRAG_MIME) ?? false

/** True from the moment a sidebar row is dragged over the window until the drag ends. */
const useSidebarRowDrag = (): boolean => {
  const [dragging, setDragging] = useState(false)

  useEffect(() => {
    const start = (event: DragEvent): void => {
      if (hasTabPayload(event)) setDragging(true)
    }
    // Deferred: a real (user-driven) drop flushes React updates between the
    // window's capture listener and React's own root listener, so ending the
    // drag synchronously here unmounts the zones before their onDrop runs.
    const stop = (): void => {
      setTimeout(() => setDragging(false), 0)
    }

    window.addEventListener('dragenter', start, true)
    // `dragend` never fires when the dragged row unmounts mid-drag. The
    // pointer does not move during a native drag, so pointer input means the
    // drag is over; without this the overlay would swallow every click.
    const endEvents = ['dragend', 'drop', 'pointermove', 'pointerdown', 'keydown']

    window.addEventListener('dragenter', start, true)
    for (const name of endEvents) window.addEventListener(name, stop, true)
    return () => {
      window.removeEventListener('dragenter', start, true)
      for (const name of endEvents) window.removeEventListener(name, stop, true)
    }
  }, [])

  return dragging
}

const ZONE_CLASSES: Record<DropZonePosition, string> = {
  left: 'absolute start-0 inset-y-0 w-1/4',
  right: 'absolute end-0 inset-y-0 w-1/4',
  top: 'absolute top-0 start-1/4 end-1/4 h-1/4',
  bottom: 'absolute bottom-0 start-1/4 end-1/4 h-1/4',
  center: 'absolute top-1/4 bottom-1/4 start-1/4 end-1/4'
}

interface NativeSplitDropZonesProps {
  groupId: string
  /**
   * Whether the pane's centre belongs to the editor. A note's editor takes the
   * drop itself (a link, or an embedded file), so the centre zone stays out of
   * its way and only the edges split.
   */
  editorOwnsCenter: boolean
}

export const NativeSplitDropZones = ({
  groupId,
  editorOwnsCenter
}: NativeSplitDropZonesProps): React.JSX.Element | null => {
  const { openTab, splitView } = useTabActions()
  const dragging = useSidebarRowDrag()
  const [hovered, setHovered] = useState<DropZonePosition | null>(null)

  if (!dragging) return null

  const zones: DropZonePosition[] = editorOwnsCenter
    ? ['left', 'right', 'top', 'bottom']
    : ['left', 'right', 'top', 'bottom', 'center']

  const handleDrop = (event: React.DragEvent, zone: DropZonePosition): void => {
    event.preventDefault()
    event.stopPropagation()
    setHovered(null)

    const tab = readTabDragData(event.dataTransfer)
    if (!tab) return

    if (zone === 'center') {
      openTab(tab, { groupId })
      return
    }

    // Naming the pane through splitView lets the open below target it in the
    // same dispatch batch. An explicit groupId also skips cross-pane dedup, so
    // the tab lands in the new pane even when it is already open elsewhere.
    const newGroupId = splitView(
      zone === 'left' || zone === 'right' ? 'horizontal' : 'vertical',
      groupId,
      { cloneActiveTab: false, position: zone === 'left' || zone === 'top' ? 'first' : 'second' }
    )
    if (newGroupId) openTab(tab, { groupId: newGroupId })
  }

  return (
    <>
      <SplitPreview zone={hovered} />
      <div className="absolute inset-0 pointer-events-none z-50" data-testid="native-drop-zones">
        {zones.map((zone) => (
          <div
            key={zone}
            data-zone={zone}
            className={cn(ZONE_CLASSES[zone], 'pointer-events-auto')}
            onDragOver={(event) => {
              if (!hasTabPayload(event)) return
              event.preventDefault()
              event.stopPropagation()
              event.dataTransfer.dropEffect = 'move'
              setHovered(zone)
            }}
            onDragLeave={() => setHovered((current) => (current === zone ? null : current))}
            onDrop={(event) => handleDrop(event, zone)}
          >
            <div
              className={cn(
                'absolute inset-2 rounded-md border-2 transition-all duration-150',
                hovered === zone
                  ? 'bg-tint-light border-dashed border-tint'
                  : 'bg-transparent border-transparent'
              )}
            >
              {hovered === zone && (
                <div className="absolute inset-0 flex items-center justify-center">
                  <div className="bg-tint text-tint-foreground px-3 py-1.5 rounded-md text-sm font-medium shadow-lg">
                    {getDropZoneLabel(zone)}
                  </div>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </>
  )
}

export default NativeSplitDropZones
