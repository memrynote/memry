import { useT } from '@memry/i18n/renderer'

import { Composer } from './composer'
import { ConversationHeader } from './conversation-header'
import { useAgentOptional } from './agent-context'
import { MessageStream } from './message-stream'
import { cn } from '@/lib/utils'

interface ConversationViewProps {
  conversationId: string | null
  layout?: 'sidebar' | 'workspace'
}

const workspaceOuterClassName =
  'mx-auto w-full max-w-[64rem] px-8 transition-[max-width] duration-300 ease-in-out lg:px-24'
const workspaceColumnClassName = 'mx-auto w-full max-w-[640px]'
const workspaceMessageListClassName = cn(workspaceColumnClassName, 'px-2')

export function ConversationView({
  conversationId,
  layout = 'sidebar'
}: ConversationViewProps): React.JSX.Element {
  const { t } = useT('common')
  const agent = useAgentOptional()
  const isWorkspace = layout === 'workspace'

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
      {conversation && !isWorkspace && <ConversationHeader conversation={conversation} />}
      {state.backendStatuses?.historyPersisted === false && (
        <p
          role="status"
          className="shrink-0 border-b border-border/60 bg-muted/40 px-4 py-2 text-xs text-muted-foreground"
        >
          {t('agentChat.historyNotSaved')}
        </p>
      )}
      <MessageStream
        messages={messages}
        inFlight={inFlight}
        contentClassName={isWorkspace ? cn(workspaceOuterClassName, 'pb-3 pt-6') : undefined}
        messageListClassName={isWorkspace ? workspaceMessageListClassName : undefined}
      />
      {isWorkspace ? (
        <div className={cn(workspaceOuterClassName, 'shrink-0 pb-10')}>
          <div className={workspaceColumnClassName}>
            <Composer conversationId={conversationId} sourceWindowId={state.sourceWindowId} />
          </div>
        </div>
      ) : (
        <Composer conversationId={conversationId} sourceWindowId={state.sourceWindowId} />
      )}
    </section>
  )
}
