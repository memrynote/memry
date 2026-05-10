import type { Conversation } from '@main/agent/storage/types'
import { useT } from '@memry/i18n/renderer'

import { Check, Plus } from '@/lib/icons'
import { cn } from '@/lib/utils'

interface ConversationListProps {
  conversations: Conversation[]
  activeConversationId: string
  onCreateConversation: () => void | Promise<void>
  onSelectConversation: (id: string) => void | Promise<void>
}

export function ConversationList({
  conversations,
  activeConversationId,
  onCreateConversation,
  onSelectConversation
}: ConversationListProps): React.JSX.Element {
  const { t } = useT('common')

  return (
    <div className="flex max-h-80 flex-col overflow-y-auto p-1">
      <button
        type="button"
        onClick={() => void onCreateConversation()}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-sm font-medium hover:bg-accent hover:text-accent-foreground"
      >
        <Plus className="size-4 text-muted-foreground" aria-hidden="true" />
        <span className="truncate">{t('agentChat.newConversation')}</span>
      </button>
      {conversations.length > 0 && <div className="my-1 h-px bg-border" />}
      {conversations.map((conversation) => {
        const active = conversation.id === activeConversationId
        return (
          <button
            key={conversation.id}
            type="button"
            aria-current={active ? 'true' : undefined}
            onClick={() => void onSelectConversation(conversation.id)}
            className={cn(
              'flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-start text-sm hover:bg-accent hover:text-accent-foreground',
              active && 'bg-accent/70 text-accent-foreground'
            )}
          >
            <span className="min-w-0 flex-1 truncate">{conversation.title}</span>
            {active && (
              <Check className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            )}
          </button>
        )
      })}
    </div>
  )
}
