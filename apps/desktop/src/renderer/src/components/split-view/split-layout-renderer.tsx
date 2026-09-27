import { useTabs } from '@/contexts/tabs'
import type { SplitDirection, SplitLayout } from '@/contexts/tabs/types'
import { SplitPane } from './split-pane'
import { TabPaneWithDropZones } from './tab-pane-with-drop-zones'

interface SplitLayoutRendererProps {
  layout: SplitLayout
  path: number[]
  reserveDayPanelSpace?: boolean
  /** Whether this branch contains the single top-right pane (only it shows the day-panel toggle) */
  showDayPanelToggle?: boolean
  /** Whether this branch contains the top-start pane (its tab bar hosts the window controls) */
  reserveWindowControls?: boolean
  /** Whether this branch touches the window top (its tab bars move into the title row while the sidebar is collapsed) */
  inTitleRow?: boolean
}

/**
 * Extract direction from a layout node, handling both current and legacy formats.
 * Legacy persisted state may have { type: 'horizontal' } instead of { type: 'split', direction: 'horizontal' }.
 */
const getLayoutDirection = (layout: SplitLayout): SplitDirection => {
  if (layout.type === 'split') return layout.direction
  // Legacy fallback: type itself was the direction name
  const raw = (layout as Record<string, unknown>).type as string
  return raw === 'vertical' ? 'vertical' : 'horizontal'
}

export const SplitLayoutRenderer = ({
  layout,
  path,
  reserveDayPanelSpace = true,
  showDayPanelToggle = true,
  reserveWindowControls = true,
  inTitleRow = true
}: SplitLayoutRendererProps): React.JSX.Element | null => {
  const { state, dispatch } = useTabs()

  if (layout.type === 'leaf') {
    const group = state.tabGroups[layout.tabGroupId]
    if (!group) return null

    return (
      <TabPaneWithDropZones
        groupId={layout.tabGroupId}
        isActive={state.activeGroupId === layout.tabGroupId}
        reserveDayPanelSpace={reserveDayPanelSpace}
        showDayPanelToggle={showDayPanelToggle}
        reserveWindowControls={reserveWindowControls}
        inTitleRow={inTitleRow}
      />
    )
  }

  const direction = getLayoutDirection(layout)

  const handleResize = (newRatio: number): void => {
    dispatch({ type: 'RESIZE_SPLIT', payload: { path, ratio: newRatio } })
  }

  return (
    <SplitPane
      direction={direction}
      ratio={layout.ratio ?? 0.5}
      onResize={handleResize}
      minSize={100}
    >
      <SplitLayoutRenderer
        layout={layout.first}
        path={[...path, 0]}
        reserveDayPanelSpace={direction === 'horizontal' ? false : reserveDayPanelSpace}
        showDayPanelToggle={direction === 'vertical' ? showDayPanelToggle : false}
        reserveWindowControls={reserveWindowControls}
        inTitleRow={inTitleRow}
      />
      <SplitLayoutRenderer
        layout={layout.second}
        path={[...path, 1]}
        reserveDayPanelSpace={reserveDayPanelSpace}
        showDayPanelToggle={direction === 'horizontal' ? showDayPanelToggle : false}
        reserveWindowControls={false}
        inTitleRow={direction === 'horizontal' ? inTitleRow : false}
      />
    </SplitPane>
  )
}

export default SplitLayoutRenderer
