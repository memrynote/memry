/**
 * Tab Pane Component
 * Single content area with tab bar and content
 */

import { useTabGroup, useTabs } from '@/contexts/tabs'
import { TabBarWithDrag } from '@/components/tabs'
import { TabContent } from './tab-content'
import { EmptyPaneState } from './empty-pane-state'
import { cn } from '@/lib/utils'

interface TabPaneProps {
  /** Group ID for this pane */
  groupId: string
  /** Whether this is the active/focused pane */
  isActive: boolean
  /** Hide tab bar (when shown in main header instead) */
  hideTabBar?: boolean
  /** Additional CSS classes */
  className?: string
}

/**
 * Single pane containing tab bar and content area
 */
export const TabPane = ({
  groupId,
  isActive,
  hideTabBar = false,
  className
}: TabPaneProps): React.JSX.Element | null => {
  const { dispatch } = useTabs()
  const group = useTabGroup(groupId)

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

  return (
    <div
      className={cn('flex flex-col h-full w-full', className)}
      onClick={handleFocus}
      data-pane-id={groupId}
      data-pane-active={isActive}
    >
      {/* Tab bar - only show if not hidden */}
      {!hideTabBar && <TabBarWithDrag groupId={groupId} />}

      {/* Content area */}
      <div className="flex-1 overflow-hidden">
        {activeTab ? (
          <TabContent tab={activeTab} groupId={groupId} />
        ) : (
          <EmptyPaneState groupId={groupId} />
        )}
      </div>
    </div>
  )
}

export default TabPane
