import { useState } from 'react'

import { useAgentOptional } from './agent-context'
import { ConversationHeader } from './conversation-header'
import { EmptyState } from './empty-state'
import { Enablement } from './enablement'

export function AgentPane(): React.JSX.Element {
  const agent = useAgentOptional()
  const [creating, setCreating] = useState(false)

  if (!agent) {
    return (
      <section className="flex h-full min-h-0 flex-col bg-sidebar" aria-label="Agent chat">
        <div className="border-b border-sidebar-border px-4 py-3">
          <h2 className="text-sm font-semibold text-foreground">Agent chat</h2>
        </div>
        <div className="min-h-0 flex-1" />
      </section>
    )
  }

  const { state } = agent

  if (state.disclosureAccepted === null || state.binaryStatus === null) {
    return (
      <div className="flex h-full items-start p-5 text-sm text-muted-foreground">
        Loading agent chat...
      </div>
    )
  }

  if (!state.disclosureAccepted) {
    return <Enablement onAccept={agent.acceptDisclosure} />
  }

  if (!state.activeConversationId) {
    return (
      <EmptyState
        binaryStatus={state.binaryStatus}
        creating={creating}
        onCreateConversation={async () => {
          setCreating(true)
          try {
            await agent.createConversation()
          } finally {
            setCreating(false)
          }
        }}
      />
    )
  }

  const activeConversation = state.conversations[state.activeConversationId]
  if (!activeConversation) {
    return (
      <div className="flex h-full items-start p-5 text-sm text-muted-foreground">
        Conversation loading...
      </div>
    )
  }

  const conversations = Object.values(state.conversations).sort((left, right) => {
    return right.updatedAt - left.updatedAt
  })

  return (
    <section className="flex h-full min-h-0 flex-col bg-sidebar" aria-label="Agent chat">
      <ConversationHeader
        conversation={activeConversation}
        conversations={conversations}
        onCreateConversation={async () => {
          await agent.createConversation()
        }}
        onSelectConversation={agent.loadConversation}
      />
      <div className="min-h-0 flex-1 p-5 text-sm text-muted-foreground">
        Conversation loading...
      </div>
    </section>
  )
}

export default AgentPane
