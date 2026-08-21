import type { Message } from '@memry/contracts/ipc-agent'
import type { AgentSourceRef } from '@memry/contracts/ipc-agent'
import { useMemo } from 'react'
import { useT } from '@memry/i18n/renderer'

import {
  Message as AIMessage,
  MessageContent,
  MessageResponse
} from '@/components/ai-elements/message'
import { AssistantActions } from './assistant-actions'
import { AgentSourceRefsProvider, CitedMemryLink } from './memry-links'
import { ThinkingIndicator } from './thinking-indicator'

/** Stable identity: a new `components` object would defeat the renderer's own memoisation. */
const markdownComponents = { a: CitedMemryLink }

type AssistantMessageModel = Message & {
  content: Extract<Message['content'], { role: 'assistant' }>
}

export function AssistantMessage({ message }: { message: Message }): React.JSX.Element | null {
  if (message.content.role !== 'assistant') return null
  return <AssistantMessageContent message={message as AssistantMessageModel} />
}

function AssistantMessageContent({
  message
}: {
  message: AssistantMessageModel
}): React.JSX.Element {
  const { t } = useT('common')
  const sourceRefs = 'sources' in message.content.data ? message.content.data.sources : undefined
  const sources = useMemo(() => uniqueSources(sourceRefs), [sourceRefs])

  if (message.status === 'streaming' && message.content.data.text.trim().length === 0) {
    return (
      <AIMessage from="assistant" className="max-w-full">
        <MessageContent
          role="status"
          aria-label={t('agentChat.thinking')}
          className="min-w-10 overflow-visible border-0 bg-transparent px-3 py-0 shadow-none"
        >
          <ThinkingIndicator label={t('agentChat.thinking')} />
        </MessageContent>
      </AIMessage>
    )
  }

  return (
    <AIMessage from="assistant" className="max-w-full">
      <MessageContent className="w-full max-w-none overflow-visible rounded-none border-0 bg-transparent px-3 py-0">
        <AgentSourceRefsProvider sources={sources}>
          <MessageResponse
            components={markdownComponents}
            isAnimating={message.status === 'streaming'}
          >
            {message.content.data.text}
          </MessageResponse>
        </AgentSourceRefsProvider>
        {message.status !== 'streaming' && (
          <AssistantActions text={message.content.data.text} sources={sources} />
        )}
      </MessageContent>
    </AIMessage>
  )
}

function uniqueSources(sources: AgentSourceRef[] | undefined): AgentSourceRef[] {
  if (!sources) return []
  const seen = new Set<string>()
  const result: AgentSourceRef[] = []
  for (const source of sources) {
    if (seen.has(source.href)) continue
    seen.add(source.href)
    result.push(source)
  }
  return result
}
