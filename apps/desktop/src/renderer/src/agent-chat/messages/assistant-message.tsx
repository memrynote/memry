import type { Message } from '@memry/contracts/ipc-agent'
import type { AgentSourceRef } from '@memry/contracts/ipc-agent'
import { useT } from '@memry/i18n/renderer'

import {
  Message as AIMessage,
  MessageContent,
  MessageResponse
} from '@/components/ai-elements/message'
import { Source, Sources, SourcesContent, SourcesTrigger } from '@/components/ai-elements/sources'
import { cn } from '@/lib/utils'
import { MemryLink, memryLinkClassName, useMemryLinkNavigation } from './memry-links'

const markdownComponents = { a: MemryLink }

export function AssistantMessage({ message }: { message: Message }): React.JSX.Element | null {
  const { t } = useT('common')
  const navigateMemryLink = useMemryLinkNavigation()
  if (message.content.role !== 'assistant') return null
  const sources = uniqueSources(message.content.data.sources)

  if (message.status === 'streaming' && message.content.data.text.trim().length === 0) {
    return (
      <AIMessage from="assistant">
        <MessageContent
          role="status"
          aria-label={t('agentChat.thinking')}
          className="min-w-10 rounded-full border border-sidebar-border/70 bg-background/80 px-3 py-2 shadow-sm"
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
    <AIMessage from="assistant">
      <MessageContent className="max-w-[92%] rounded-lg border border-sidebar-border bg-background px-3 py-2">
        <MessageResponse components={markdownComponents}>
          {message.content.data.text}
        </MessageResponse>
        {sources.length > 0 && (
          <Sources className="mb-0 mt-1">
            <SourcesTrigger
              count={sources.length}
              label={t('agentChat.sources.used', {
                count: sources.length,
                defaultValue: `Used ${sources.length} sources`
              })}
              className={cn(memryLinkClassName, 'w-fit text-xs')}
            />
            <SourcesContent className="w-full">
              {sources.map((source) => (
                <Source
                  key={source.href}
                  className={cn('flex w-fit items-center gap-2 text-xs', memryLinkClassName)}
                  href={source.href}
                  onClick={(event) => {
                    event.preventDefault()
                    navigateMemryLink(source.href, source.title)
                  }}
                  title={source.title}
                />
              ))}
            </SourcesContent>
          </Sources>
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
