import type { Message } from '@memry/contracts/ipc-agent'
import type { AgentSourceRef } from '@memry/contracts/ipc-agent'
import type { ComponentProps } from 'react'
import { useMemo } from 'react'
import { useT } from '@memry/i18n/renderer'

import {
  Message as AIMessage,
  MessageContent,
  MessageResponse
} from '@/components/ai-elements/message'
import { Source, Sources, SourcesContent, SourcesTrigger } from '@/components/ai-elements/sources'
import { cn } from '@/lib/utils'
import { MemryLink, MemryLinkIcon, splitEdgeIcon, useMemryLinkNavigation } from './memry-links'
import { memryLinkClassName } from './memry-links-constants'

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
  const sourceSignature = useMemo(() => signatureForSources(sources), [sources])
  const markdownComponents = useMemo(() => {
    const sourceByHref = new Map(sources.map((source) => [source.href, source]))
    return {
      a: (props: ComponentProps<'a'>) => (
        <MemryLink
          {...props}
          source={typeof props.href === 'string' ? sourceByHref.get(props.href) : null}
        />
      )
    }
  }, [sources])

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
        <MessageResponse key={sourceSignature} components={markdownComponents}>
          {message.content.data.text}
        </MessageResponse>
        {sources.length > 0 && <AssistantSources sources={sources} />}
      </MessageContent>
    </AIMessage>
  )
}

function AssistantSources({ sources }: { sources: AgentSourceRef[] }): React.JSX.Element {
  const { t } = useT('common')
  const navigateMemryLink = useMemryLinkNavigation()

  return (
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
        {sources.map((source) => {
          const { icon, label } = splitEdgeIcon(source.title)
          return (
            <Source
              key={source.href}
              className={cn('flex w-fit items-center gap-2 text-xs', memryLinkClassName)}
              href={source.href}
              onClick={(event) => {
                event.preventDefault()
                navigateMemryLink(source.href, source.title)
              }}
              title={source.title}
            >
              <MemryLinkIcon href={source.href} source={source} fallbackIcon={icon} />
              <span className="block font-medium">{label}</span>
            </Source>
          )
        })}
      </SourcesContent>
    </Sources>
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

function signatureForSources(sources: AgentSourceRef[]): string {
  return sources
    .map(
      (source) =>
        `${source.href}:${source.icon ?? ''}:${source.itemType ?? ''}:${source.visualType ?? ''}`
    )
    .join('\u0000')
}
