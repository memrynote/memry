import { useEffect } from 'react'

import { ConversationView } from './conversation-view'
import { useAgentOptional } from './agent-context'

interface AgentConversationTabProps {
  conversationId?: string
}

export function AgentConversationTab({
  conversationId
}: AgentConversationTabProps): React.JSX.Element {
  const agent = useAgentOptional()
  const hasConversation = conversationId
    ? Boolean(agent?.state.conversations[conversationId])
    : false
  const hasMessages = conversationId
    ? agent?.state.messagesByConversation[conversationId] !== undefined
    : false

  useEffect(() => {
    if (!agent || !conversationId || (hasConversation && hasMessages)) return
    void agent.loadConversation(conversationId, { activate: false })
  }, [agent, conversationId, hasConversation, hasMessages])

  return <ConversationView conversationId={conversationId ?? null} layout="workspace" />
}
