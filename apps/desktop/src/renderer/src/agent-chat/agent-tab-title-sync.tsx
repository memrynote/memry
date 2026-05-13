import { useEffect } from 'react'

import { useTabs } from '@/contexts/tabs'
import { useAgentOptional } from './agent-context'

export function AgentTabTitleSync(): null {
  const agent = useAgentOptional()
  const { state, updateTabTitle } = useTabs()

  useEffect(() => {
    if (!agent) return
    for (const [groupId, group] of Object.entries(state.tabGroups)) {
      for (const tab of group.tabs) {
        if (tab.type !== 'agent-chat' || !tab.entityId) continue
        const conversation = agent.state.conversations[tab.entityId]
        if (!conversation || conversation.title === tab.title) continue
        updateTabTitle(tab.id, conversation.title, groupId)
      }
    }
  }, [agent, state.tabGroups, updateTabTitle])

  return null
}
