import { useTabs } from '@/contexts/tabs'
import type { SplitDirection, SplitLayout } from '@/contexts/tabs/types'
import { SplitPane } from './split-pane'
import { TabPane } from './tab-pane'

interface SplitLayoutRendererProps {
  layout: SplitLayout
  path: number[]
  showSidebarToggle?: boolean
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
  showSidebarToggle = true
}: SplitLayoutRendererProps): React.JSX.Element | null => {
  const { state, dispatch } = useTabs()

  if (layout.type === 'leaf') {
    const group = state.tabGroups[layout.tabGroupId]
    if (!group) return null

    return (
      <TabPane
        groupId={layout.tabGroupId}
        isActive={state.activeGroupId === layout.tabGroupId}
        showSidebarToggle={showSidebarToggle}
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
        showSidebarToggle={showSidebarToggle}
      />
      <SplitLayoutRenderer layout={layout.second} path={[...path, 1]} showSidebarToggle={false} />
    </SplitPane>
  )
}

export default SplitLayoutRenderer
