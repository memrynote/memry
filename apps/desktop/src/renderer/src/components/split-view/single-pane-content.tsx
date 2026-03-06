/**
 * Single Pane Content Component
 * Wrapper for TabContent in single-pane (non-split) mode
 *
 * This component provides a unified entry point for rendering tab content
 * when the app is in single-pane mode (no splits). It delegates to TabContent
 * which handles scroll position persistence and tab-type routing.
 */

import { useTabs, useActiveTab } from '@/contexts/tabs'
import { TabContent } from './tab-content'
import { EmptyPaneState } from './empty-pane-state'

/**
 * Renders the active tab's content in single-pane mode
 * Uses TabContent internally for consistent behavior with split-view mode
 */
export const SinglePaneContent = (): React.JSX.Element => {
  const activeTab = useActiveTab()
  const { state } = useTabs()

  if (!activeTab) {
    return <EmptyPaneState groupId={state.activeGroupId} />
  }

  return <TabContent tab={activeTab} groupId={state.activeGroupId} />
}

export default SinglePaneContent
