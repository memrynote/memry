import type { Conversation } from '@memry/contracts/ipc-agent'
interface ConversationHeaderProps {
  conversation: Conversation
}

export function ConversationHeader({ conversation }: ConversationHeaderProps): React.JSX.Element {
  return (
    <header className="flex min-h-[49px] items-center border-t border-sidebar-border px-3 py-2">
      <span className="min-w-0 truncate px-2 text-sm font-semibold text-foreground">
        {conversation.title}
      </span>
    </header>
  )
}
