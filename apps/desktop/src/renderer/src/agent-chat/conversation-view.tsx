import { Button } from '@/components/ui/button'
import { Square } from '@/lib/icons'
import { Composer } from './composer'
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
  const inFlight = state.inFlight[conversationId] === true
  const currentAgent = agent

  function cancelTurn(): void {
    void currentAgent.cancelTurn(conversationId)
  }

  return (
    <section
      className="flex h-full min-h-0 flex-col bg-sidebar"
      aria-label="Agent chat"
      tabIndex={-1}
      onKeyDown={(event) => {
        if (!inFlight || event.key !== 'Escape') return
        event.preventDefault()
        cancelTurn()
      }}
    >
      <ConversationHeader
        conversation={conversation}
        conversations={conversations}
        onCreateConversation={async () => {
          await currentAgent.createConversation()
        }}
        onSelectConversation={currentAgent.loadConversation}
      />
      {inFlight && (
        <div className="flex items-center justify-end border-b border-sidebar-border px-3 py-2">
          <Button type="button" variant="secondary" size="sm" onClick={cancelTurn}>
            <Square className="size-3" aria-hidden="true" />
            Stop
          </Button>
        </div>
      )}
      <MessageStream messages={messages} />
      <Composer conversationId={conversationId} sourceWindowId={state.sourceWindowId} />
    </section>
  )
}
