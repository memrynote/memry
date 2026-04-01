import { useTabGroup, useTabs } from '@/contexts/tabs'
import { useDayPanel } from '@/contexts/day-panel-context'
import { TabBarWithDrag } from '@/components/tabs'
import { TabContent } from './tab-content'
import { EmptyPaneState } from './empty-pane-state'
import { cn } from '@/lib/utils'

interface TabPaneProps {
  groupId: string
  isActive: boolean
  className?: string
}

export const TabPane = ({
  groupId,
  isActive,
  className
}: TabPaneProps): React.JSX.Element | null => {
  const { dispatch } = useTabs()
  const group = useTabGroup(groupId)
  const {
    isOpen: isDayPanelOpen,
    width: dayPanelWidth,
    isResizing: dayPanelResizing
  } = useDayPanel()

  if (!group) return null

  const activeTab = group.tabs.find((t) => t.id === group.activeTabId)

  const handleFocus = (): void => {
    if (!isActive) {
      dispatch({ type: 'SET_ACTIVE_GROUP', payload: { groupId } })
    }
  }

  return (
    <div
      className={cn('flex flex-col h-full w-full', className)}
      onClick={handleFocus}
      data-testid="tab-pane"
      data-pane-id={groupId}
      data-pane-active={isActive}
    >
      <TabBarWithDrag groupId={groupId} />

      <div
        className={cn(
          'flex-1 overflow-hidden',
          !dayPanelResizing && 'transition-[margin] duration-200 ease-linear'
        )}
        style={{ marginRight: isDayPanelOpen ? `${dayPanelWidth}px` : 0 }}
      >
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
