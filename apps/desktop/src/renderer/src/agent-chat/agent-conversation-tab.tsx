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

  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-[64rem] flex-col bg-background px-8 pb-10 pt-6 transition-[max-width] duration-300 ease-in-out lg:px-24">
      <div className="mx-auto flex h-full min-h-0 w-full max-w-[640px] flex-col">
        <ConversationView conversationId={conversationId ?? null} />
      </div>
    </div>
  )
}
