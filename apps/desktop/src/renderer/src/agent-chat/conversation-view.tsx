import { useT } from '@memry/i18n/renderer'

import { Composer } from './composer'
import { ConversationHeader } from './conversation-header'
import { useAgentOptional } from './agent-context'
import { MessageStream } from './message-stream'

interface ConversationViewProps {
  conversationId: string | null
}

export function ConversationView({ conversationId }: ConversationViewProps): React.JSX.Element {
  const { t } = useT('common')
  const agent = useAgentOptional()

  if (!agent) {
    return (
      <div className="flex h-full items-start p-5 text-sm text-muted-foreground">
        {t('agentChat.conversationLoading')}
      </div>
    )
  }

  const { state } = agent
  const conversation = conversationId ? state.conversations[conversationId] : null

  if (conversationId && !conversation) {
    return (
      <div className="flex h-full items-start p-5 text-sm text-muted-foreground">
        {t('agentChat.conversationLoading')}
      </div>
    )
  }

  const messages = conversationId ? (state.messagesByConversation[conversationId] ?? []) : []
  const inFlight = conversationId ? state.inFlight[conversationId] === true : false
  const currentAgent = agent

  function cancelTurn(): void {
    if (!conversationId) return
    void currentAgent.cancelTurn(conversationId)
  }

  return (
    <section
      className="flex h-full min-h-0 flex-col bg-background"
      aria-label={t('agentChat.title')}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (!inFlight || event.key !== 'Escape') return
        event.preventDefault()
        cancelTurn()
      }}
    >
      {conversation && <ConversationHeader conversation={conversation} />}
      <MessageStream messages={messages} />
      <Composer conversationId={conversationId} sourceWindowId={state.sourceWindowId} />
    </section>
  )
}
