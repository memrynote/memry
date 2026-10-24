import { useEffect, useState, type ReactNode } from 'react'

import { useAISettingsContext } from '@/contexts/ai-settings-context'
import { useDayPanel } from '@/contexts/day-panel-context'
import { useActiveTab } from '@/contexts/tabs'
import { AgentProvider } from './agent-context'
import { RIGHT_SIDEBAR_TAB_KEY } from './sidebar-tabs'

/**
 * Gates the agent bootstrap (IPC probes + event subscription) so it only runs
 * once an agent surface is reachable.
 *
 * The gate never adds or removes a tree level: `AgentProvider` stays mounted
 * and only its `active` prop flips. Swapping between a fragment and a provider
 * changes the element type at this position, which makes React unmount and
 * remount the entire app below it — discarding the click that opened the agent
 * surface, so the sidebar tab only appeared to respond on the second click.
 */
export function AgentFeatureProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const { enabled } = useAISettingsContext()
  const activeTab = useActiveTab()
  const { isOpen: isDayPanelOpen } = useDayPanel()
  const [activated, setActivated] = useState(false)

  useEffect(() => {
    const activate = () => setActivated(true)
    window.addEventListener('memry:agent-surface-opened', activate)
    return () => window.removeEventListener('memry:agent-surface-opened', activate)
  }, [])

  const isPersistedAgentPanelOpen = isDayPanelOpen && readPersistedRightSidebarTab() === 'agent'
  const shouldMountAgent =
    enabled && (activated || activeTab?.type === 'agent-chat' || isPersistedAgentPanelOpen)

  return <AgentProvider active={shouldMountAgent}>{children}</AgentProvider>
}

function readPersistedRightSidebarTab(): string | null {
  try {
    return localStorage.getItem(RIGHT_SIDEBAR_TAB_KEY)
  } catch {
    return null
  }
}
