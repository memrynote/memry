/**
 * Tab Pane with Drop Zones
 * Enhanced TabPane with drag-to-split functionality
 */

import { useState } from 'react'
import { useDndMonitor } from '@dnd-kit/core'
import { useTabGroup, useTabs } from '@/contexts/tabs'
import { TabBarWithDrag } from '@/components/tabs'
import { TabContent } from './tab-content'
import { EmptyPaneState } from './empty-pane-state'
import { SplitDropZones } from './split-drop-zones'
import { SplitPreview } from './split-preview'
import type { DropZonePosition } from './drop-zone'
import { cn } from '@/lib/utils'

interface TabPaneWithDropZonesProps {
  /** Group ID for this pane */
  groupId: string
  /** Whether this is the active/focused pane */
  isActive: boolean
  /** Additional CSS classes */
  className?: string
}

/**
 * Tab pane with integrated drop zones for drag-to-split
 */
export const TabPaneWithDropZones = ({
  groupId,
  isActive,
  className
}: TabPaneWithDropZonesProps): React.JSX.Element | null => {
  const { dispatch } = useTabs()
  const group = useTabGroup(groupId)

  // Drag state
  const [isDraggingTab, setIsDraggingTab] = useState(false)
  const [draggedTabInfo, setDraggedTabInfo] = useState<{
    tabId: string
    fromGroupId: string
  } | null>(null)
  const [hoveredZone, setHoveredZone] = useState<DropZonePosition | null>(null)

  // Listen for drag events
  useDndMonitor({
    onDragStart: (event) => {
      const { active } = event
      if (active.data.current?.type === 'tab') {
        setIsDraggingTab(true)
        setDraggedTabInfo({
          tabId: active.id as string,
          fromGroupId: active.data.current.groupId
        })
      }
    },
    onDragOver: (event) => {
      const { over } = event
      if (over?.data.current?.type === 'split-zone') {
        const zone = over.data.current.zone as DropZonePosition
        const targetGroupId = over.data.current.groupId as string
        if (targetGroupId === groupId) {
          setHoveredZone(zone)
        }
      } else {
        setHoveredZone(null)
      }
    },
    onDragEnd: (event) => {
      const { over } = event

      // Handle drop on split zone
      if (
        over?.data.current?.type === 'split-zone' &&
        draggedTabInfo &&
        over.data.current.groupId === groupId
      ) {
        const zone = over.data.current.zone as DropZonePosition
        handleZoneDrop(zone, draggedTabInfo.tabId, draggedTabInfo.fromGroupId)
      }

      // Reset drag state
      setIsDraggingTab(false)
      setDraggedTabInfo(null)
      setHoveredZone(null)
    },
    onDragCancel: () => {
      setIsDraggingTab(false)
      setDraggedTabInfo(null)
      setHoveredZone(null)
    }
  })

  if (!group) return null

  // Find active tab
  const activeTab = group.tabs.find((t) => t.id === group.activeTabId)

  // Handle focus when clicking on pane
  const handleFocus = (): void => {
    if (!isActive) {
      dispatch({
        type: 'SET_ACTIVE_GROUP',
        payload: { groupId }
      })
    }
  }

  // Handle drop on zone
  const handleZoneDrop = (zone: DropZonePosition, tabId: string, fromGroupId: string): void => {
    if (zone === 'center') {
      // Move tab to this group (no split)
      if (fromGroupId !== groupId) {
        dispatch({
          type: 'MOVE_TAB',
          payload: {
            tabId,
            fromGroupId,
            toGroupId: groupId,
            toIndex: group.tabs.length
          }
        })
      }
    } else {
      // Create horizontal split and move tab
      const direction = 'horizontal'
      const position = zone === 'left' ? 'first' : 'second'

      dispatch({
        type: 'MOVE_TAB_TO_NEW_SPLIT',
        payload: {
          tabId,
          fromGroupId,
          targetGroupId: groupId,
          direction,
          position
        }
      })
    }
  }

  // Show drop zones when dragging a tab
  const showDropZones = isDraggingTab && draggedTabInfo !== null

  return (
    <div
      className={cn('relative flex flex-col h-full w-full', className)}
      onClick={handleFocus}
      data-pane-id={groupId}
      data-pane-active={isActive}
    >
      {/* Tab bar */}
      <TabBarWithDrag groupId={groupId} />

      {/* Content area */}
      <div className="flex-1 overflow-hidden relative">
        {activeTab ? (
          <TabContent tab={activeTab} groupId={groupId} />
        ) : (
          <EmptyPaneState groupId={groupId} />
        )}

        {/* Split preview */}
        <SplitPreview zone={hoveredZone} />

        {/* Drop zones overlay */}
        <SplitDropZones groupId={groupId} isActive={showDropZones} />
      </div>
    </div>
  )
}

export default TabPaneWithDropZones
