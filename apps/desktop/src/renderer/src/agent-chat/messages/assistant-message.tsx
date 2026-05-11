import type { Message } from '@memry/contracts/ipc-agent'
import { useT } from '@memry/i18n/renderer'

import {
  Message as AIMessage,
  MessageContent,
  MessageResponse
} from '@/components/ai-elements/message'

export function AssistantMessage({ message }: { message: Message }): React.JSX.Element | null {
  const { t } = useT('common')
  if (message.content.role !== 'assistant') return null

  if (message.status === 'streaming' && message.content.data.text.trim().length === 0) {
    return (
      <AIMessage from="assistant">
        <MessageContent
          role="status"
          aria-label={t('agentChat.thinking')}
          className="rounded-full border border-sidebar-border/70 bg-background/80 px-3 py-2 shadow-sm"
        >
          <span className="flex items-center gap-1.5" aria-hidden="true">
            <span className="size-1.5 animate-pulse rounded-full bg-muted-foreground/70" />
            <span className="size-1.5 animate-pulse rounded-full bg-muted-foreground/70 [animation-delay:150ms]" />
            <span className="size-1.5 animate-pulse rounded-full bg-muted-foreground/70 [animation-delay:300ms]" />
          </span>
        </MessageContent>
      </AIMessage>
    )
  }

  return (
    <AIMessage from="assistant">
      <MessageContent className="max-w-[92%] rounded-lg border border-sidebar-border bg-background px-3 py-2">
        <MessageResponse>{message.content.data.text}</MessageResponse>
      </MessageContent>
    </AIMessage>
  )
}
