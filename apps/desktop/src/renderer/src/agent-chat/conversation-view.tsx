import { ConversationHeader } from './conversation-header'
import { useAgentOptional } from './agent-context'
import { MessageStream } from './message-stream'

interface ConversationViewProps {
  conversationId: string
}

export function ConversationView({ conversationId }: ConversationViewProps): React.JSX.Element {
  const agent = useAgentOptional()

  if (!agent) {
    return (
      <div className="flex h-full items-start p-5 text-sm text-muted-foreground">
        Conversation loading...
      </div>
    )
  }

  const { state } = agent
  const conversation = state.conversations[conversationId]

  if (!conversation) {
    return (
      <div className="flex h-full items-start p-5 text-sm text-muted-foreground">
        Conversation loading...
      </div>
    )
  }

  const conversations = Object.values(state.conversations).sort((left, right) => {
    return right.updatedAt - left.updatedAt
  })
  const messages = state.messagesByConversation[conversationId] ?? []

  return (
    <section className="flex h-full min-h-0 flex-col bg-sidebar" aria-label="Agent chat">
      <ConversationHeader
        conversation={conversation}
        conversations={conversations}
        onCreateConversation={async () => {
          await agent.createConversation()
        }}
        onSelectConversation={agent.loadConversation}
      />
      <MessageStream messages={messages} />
    </section>
  )
}
