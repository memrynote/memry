/**
 * Tab Drag Provider Component
 * Provides shared DndContext for tab drag-drop across panels
 */

import { useState, useMemo, type ReactNode } from 'react'
import { DragOverlay, useDndMonitor, type DragStartEvent, type DragEndEvent } from '@dnd-kit/core'
import { useTabs } from '@/contexts/tabs'
import { TabDragOverlay } from './tab-drag-overlay'
import type { Tab } from '@/contexts/tabs/types'

interface TabDragProviderProps {
  children: ReactNode
}

/**
 * Shared drag context for tab dragging between panels
 * Should wrap both header (with tab bars) and content area
 */
export const TabDragProvider = ({ children }: TabDragProviderProps): React.JSX.Element => {
  const { state, dispatch } = useTabs()
  const [activeTab, setActiveTab] = useState<Tab | null>(null)

  // Collect all tabs from all groups for finding dragged tab
  const allTabs = useMemo(() => {
    return Object.values(state.tabGroups).flatMap((g) => g.tabs)
  }, [state.tabGroups])

  useDndMonitor({
    onDragStart: (event: DragStartEvent) => {
      if (event.active.data.current?.type !== 'tab') return

      const draggedTab = allTabs.find((t) => t.id === event.active.id)
      if (draggedTab) {
        setActiveTab(draggedTab)
      }
    },
    onDragEnd: (event: DragEndEvent) => {
      if (event.active.data.current?.type !== 'tab') {
        setActiveTab(null)
        return
      }

      const { active, over } = event
      setActiveTab(null)

      if (!over || active.id === over.id) return

      // Get source and target group info
      const sourceGroupId = active.data.current?.groupId as string | undefined
      const targetGroupId = over.data.current?.groupId as string | undefined

      if (!sourceGroupId || !targetGroupId) return

      if (sourceGroupId !== targetGroupId) {
        // Cross-group move
        const targetGroup = state.tabGroups[targetGroupId]
        const toIndex = targetGroup?.tabs.length ?? 0

        dispatch({
          type: 'MOVE_TAB',
          payload: {
            tabId: active.id as string,
            fromGroupId: sourceGroupId,
            toGroupId: targetGroupId,
            toIndex
          }
        })
      } else {
        // Same group reorder
        const group = state.tabGroups[sourceGroupId]
        if (!group) return

        const pinnedTabs = group.tabs.filter((t) => t.isPinned)
        const regularTabs = group.tabs.filter((t) => !t.isPinned)

        const oldIndex = regularTabs.findIndex((t) => t.id === active.id)
        const newIndex = regularTabs.findIndex((t) => t.id === over.id)

        if (oldIndex !== -1 && newIndex !== -1 && oldIndex !== newIndex) {
          const pinnedCount = pinnedTabs.length
          dispatch({
            type: 'REORDER_TABS',
            payload: {
              groupId: sourceGroupId,
              fromIndex: oldIndex + pinnedCount,
              toIndex: newIndex + pinnedCount
            }
          })
        }
      }
    },
    onDragCancel: () => {
      setActiveTab(null)
    }
  })

  return (
    <>
      {children}

      {/* Shared drag overlay for cross-panel dragging */}
      <DragOverlay dropAnimation={null}>
        {activeTab ? <TabDragOverlay tab={activeTab} /> : null}
      </DragOverlay>
    </>
  )
}

export default TabDragProvider
