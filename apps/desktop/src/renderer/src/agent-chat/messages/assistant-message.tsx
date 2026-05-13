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
      <AIMessage from="assistant" className="max-w-full">
        <MessageContent
          role="status"
          aria-label={t('agentChat.thinking')}
          className="min-w-10 overflow-visible border-0 bg-transparent px-3 py-0 shadow-none"
        >
          <span className="flex items-center gap-1.5" aria-hidden="true">
            <span className="size-2 animate-pulse rounded-full bg-foreground/60" />
            <span className="size-2 animate-pulse rounded-full bg-foreground/60 [animation-delay:150ms]" />
            <span className="size-2 animate-pulse rounded-full bg-foreground/60 [animation-delay:300ms]" />
          </span>
        </MessageContent>
      </AIMessage>
    )
  }

  return (
    <AIMessage from="assistant" className="max-w-full">
      <MessageContent className="w-full max-w-none overflow-visible rounded-none border-0 bg-transparent px-3 py-0">
        <MessageResponse>{message.content.data.text}</MessageResponse>
      </MessageContent>
    </AIMessage>
  )
}
