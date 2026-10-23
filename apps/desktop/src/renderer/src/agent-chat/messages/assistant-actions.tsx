import type { AgentSourceRef } from '@memry/contracts/ipc-agent'
import { useEffect, useRef, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { useT } from '@memry/i18n/renderer'

import { Source, Sources, SourcesContent, SourcesTrigger } from '@/components/ai-elements/sources'
import { cn } from '@/lib/utils'
import { MemryLinkIcon, splitEdgeIcon, useMemryLinkNavigation } from './memry-links'

/** The stack reads as a stack, not a crowd; the rest live in the count. */
const STACKED_ICON_LIMIT = 3
const COPIED_RESET_MS = 1500

/**
 * The row under a finished answer: copy it, or open the vault items the turn
 * leaned on. It stays visible rather than appearing on hover — the source count
 * is part of the answer, not a control.
 */
export function AssistantActions({
  text,
  sources
}: {
  text: string
  sources: AgentSourceRef[]
}): React.JSX.Element {
  const { t } = useT('common')
  const hasSources = sources.length > 0

  return (
    <Sources className="not-prose mb-0 mt-2 text-xs text-inherit">
      <div className="flex items-center gap-0.5">
        <CopyButton text={text} />
        {hasSources && (
          <SourcesTrigger
            count={sources.length}
            className="ms-1.5 flex items-center gap-1.5 rounded-[6px] px-1 py-0.5 text-start transition-colors duration-150 hover:bg-accent"
          >
            <span className="flex -space-x-1">
              {sources.slice(0, STACKED_ICON_LIMIT).map((source) => (
                <span
                  key={source.href}
                  className="flex size-3.5 items-center justify-center rounded-full bg-background ring-[1.5px] ring-background"
                >
                  <MemryLinkIcon
                    href={source.href}
                    source={source}
                    fallbackIcon={splitEdgeIcon(source.title).icon}
                    className="size-2.5"
                  />
                </span>
              ))}
            </span>
            <span className="text-[12px] text-muted-foreground">
              {t('agentChat.sources.count', {
                count: sources.length,
                defaultValue: `${sources.length} sources`
              })}
            </span>
          </SourcesTrigger>
        )}
      </div>

      {hasSources && <AssistantSourceList sources={sources} />}
    </Sources>
  )
}

/**
 * Split out so an answer without sources never reaches for tab navigation — the
 * row itself has to render in places that have no TabProvider around it.
 */
function AssistantSourceList({ sources }: { sources: AgentSourceRef[] }): React.JSX.Element {
  const navigateMemryLink = useMemryLinkNavigation()

  return (
    <SourcesContent className="mt-1.5 flex w-full flex-col gap-0 rounded-[10px] border border-border bg-muted/40 p-1 duration-300 ease-[cubic-bezier(0.23,1,0.32,1)]">
      {sources.map((source) => {
        const { icon, label } = splitEdgeIcon(source.title)
        return (
          <Source
            key={source.href}
            className="flex items-center gap-2 rounded-[6px] px-1.5 py-1 text-[12px] text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground"
            href={source.href}
            onClick={(event) => {
              event.preventDefault()
              navigateMemryLink(source.href, source.title)
            }}
            title={source.title}
          >
            <MemryLinkIcon
              href={source.href}
              source={source}
              fallbackIcon={icon}
              className="size-4"
            />
            <span className="block truncate font-medium">{label}</span>
            <span className="ms-auto shrink-0 font-mono text-[10.5px] text-muted-foreground/70">
              {typeLabel(source)}
            </span>
          </Source>
        )
      })}
    </SourcesContent>
  )
}

function CopyButton({ text }: { text: string }): React.JSX.Element {
  const { t } = useT('common')
  const [copied, setCopied] = useState(false)
  const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => () => clearTimeout(resetTimer.current), [])

  const label = copied
    ? t('agentChat.actions.copied', { defaultValue: 'Copied' })
    : t('agentChat.actions.copy', { defaultValue: 'Copy' })

  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={() => {
        // The vault speaks markdown, so hand over the markdown the model wrote
        // rather than the flattened text the DOM happens to show.
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true)
          clearTimeout(resetTimer.current)
          resetTimer.current = setTimeout(() => setCopied(false), COPIED_RESET_MS)
        })
      }}
      className={cn(
        'flex size-6 items-center justify-center rounded-[6px] text-muted-foreground',
        'transition-colors duration-100 hover:bg-accent hover:text-foreground'
      )}
    >
      {copied ? <Check className="size-[15px]" /> : <Copy className="size-[15px]" />}
    </button>
  )
}

/**
 * The reference shows a domain here; a vault item has no domain, so the kind is
 * what tells a note apart from a task at a glance.
 */
function typeLabel(source: AgentSourceRef): string {
  if (source.kind === 'inbox' && source.itemType) return source.itemType
  if (source.kind === 'calendar_event') return 'calendar'
  return source.kind
}
