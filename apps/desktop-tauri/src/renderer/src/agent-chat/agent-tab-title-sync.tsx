import { useEffect } from 'react'

import { useTabs } from '@/contexts/tabs'
import { useAgentOptional } from './agent-context'

export function AgentTabTitleSync(): null {
  const agent = useAgentOptional()
  const { state, updateTabTitle } = useTabs()
  const tabGroups = state?.tabGroups

  useEffect(() => {
    if (!agent || !tabGroups) return
    for (const [groupId, group] of Object.entries(tabGroups)) {
      for (const tab of group.tabs) {
        if (tab.type !== 'agent-chat' || !tab.entityId) continue
        const conversation = agent.state.conversations[tab.entityId]
        if (!conversation || conversation.title === tab.title) continue
        updateTabTitle(tab.id, conversation.title, groupId)
      }
    }
  }, [agent, tabGroups, updateTabTitle])

  return null
}
