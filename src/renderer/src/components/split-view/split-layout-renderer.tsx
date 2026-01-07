/**
 * Split Layout Renderer Component
 * Recursively renders the split layout tree
 */

import { useTabs } from '@/contexts/tabs'
import type { SplitLayout } from '@/contexts/tabs/types'
import { SplitPane } from './split-pane'
import { TabPane } from './tab-pane'

interface SplitLayoutRendererProps {
  /** Layout tree to render */
  layout: SplitLayout
  /** Path in tree for resize operations */
  path: number[]
  /** Hide tab bars in panes */
  hideTabBars?: boolean
}

/**
 * Recursively renders split layout tree
 */
export const SplitLayoutRenderer = ({
  layout,
  path,
  hideTabBars = false
}: SplitLayoutRendererProps): React.JSX.Element | null => {
  const { state, dispatch } = useTabs()

  // Leaf node - render tab pane
  if (layout.type === 'leaf') {
    const group = state.tabGroups[layout.tabGroupId]
    if (!group) return null

    return (
      <TabPane
        groupId={layout.tabGroupId}
        isActive={state.activeGroupId === layout.tabGroupId}
        hideTabBar={hideTabBars}
      />
    )
  }

  // Branch node - render split container
  const isHorizontal = layout.type === 'horizontal'

  const handleResize = (newRatio: number): void => {
    dispatch({
      type: 'RESIZE_SPLIT',
      payload: { path, ratio: newRatio }
    })
  }

  return (
    <SplitPane
      direction={isHorizontal ? 'horizontal' : 'vertical'}
      ratio={layout.ratio}
      onResize={handleResize}
      minSize={100}
    >
      {/* First child */}
      <SplitLayoutRenderer layout={layout.first} path={[...path, 0]} hideTabBars={hideTabBars} />

      {/* Second child */}
      <SplitLayoutRenderer layout={layout.second} path={[...path, 1]} hideTabBars={hideTabBars} />
    </SplitPane>
  )
}

export default SplitLayoutRenderer
