import type { Message } from '@memry/contracts/ipc-agent'
import type { AgentSourceRef } from '@memry/contracts/ipc-agent'
import { useMemo } from 'react'
import { useT } from '@memry/i18n/renderer'

import {
  Message as AIMessage,
  MessageContent,
  MessageResponse
} from '@/components/ai-elements/message'
import { ThinkingReasoning } from '@/components/ai-elements/thinking-reasoning'
import { useStreamingText } from '@/components/ai-elements/use-streaming-text'
import { cn } from '@/lib/utils'
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
  const streaming = message.status === 'streaming'
  const { shown, typing } = useStreamingText(message.content.data.text)
  const answerStarted = message.content.data.text.trim().length > 0
  const reasoning = message.content.data.reasoning ?? ''
  const hasReasoning = reasoning.trim().length > 0

  if (streaming && !answerStarted && !hasReasoning) {
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
        {hasReasoning && (
          <ThinkingReasoning
            thinking={streaming && !answerStarted}
            content={reasoning}
            durationMs={message.content.data.reasoningDurationMs}
            thinkingLabel={t('agentChat.reasoning.thinking')}
            formatSummary={(seconds) =>
              seconds === null
                ? t('agentChat.reasoning.thought')
                : t('agentChat.reasoning.thoughtFor', { seconds })
            }
            toggleLabel={t('agentChat.reasoning.toggle')}
          >
            <MessageResponse className="space-y-2 text-[13px] leading-5 text-muted-foreground">
              {reasoning}
            </MessageResponse>
          </ThinkingReasoning>
        )}
        {(answerStarted || !streaming) && (
          <AgentSourceRefsProvider sources={sources}>
            <MessageResponse
              components={markdownComponents}
              isAnimating={streaming || typing}
              className={cn(
                (streaming || typing) && 'aicss-stream-caret',
                typing && 'aicss-stream-caret-steady'
              )}
            >
              {shown}
            </MessageResponse>
          </AgentSourceRefsProvider>
        )}
        {!streaming && !typing && (
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
