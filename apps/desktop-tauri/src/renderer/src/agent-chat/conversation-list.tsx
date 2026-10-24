import type { Conversation } from '@memry/contracts/ipc-agent'

import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { Check } from '@/lib/icons'
import { cn } from '@/lib/utils'

interface ConversationListProps {
  conversations: Conversation[]
  activeConversationId: string | null
  onSelectConversation: (id: string) => void | Promise<void>
}

export function ConversationList({
  conversations,
  activeConversationId,
  onSelectConversation
}: ConversationListProps): React.JSX.Element {
  return (
    <div className="flex max-h-80 flex-col overflow-y-auto">
      {conversations.map((conversation) => {
        const active = conversation.id === activeConversationId
        return (
          <DropdownMenuItem
            key={conversation.id}
            aria-current={active ? 'true' : undefined}
            onSelect={() => void onSelectConversation(conversation.id)}
            className={cn(
              'min-w-0 text-xs hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground',
              active && 'bg-accent/70 text-accent-foreground'
            )}
          >
            <span className="min-w-0 flex-1 truncate">{conversation.title}</span>
            {active && (
              <Check className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            )}
          </DropdownMenuItem>
        )
      })}
    </div>
  )
}
