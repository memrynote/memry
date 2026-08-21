import { useState } from 'react'

import type { Message, ToolCallStatus } from '@memry/contracts/ipc-agent'
import { useT } from '@memry/i18n/renderer'

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { ChevronRight } from '@/lib/icons'
import { cn } from '@/lib/utils'

import { humanizeToolName } from './tool-call-message'
import { ThinkingPixels } from './thinking-indicator'

const settledStatuses = new Set<ToolCallStatus>([
  'completed',
  'denied',
  'failed',
  'output-available',
  'output-denied',
  'output-error'
])

interface ActivitySummary {
  activeLabel: string | null
  awaitingApproval: boolean
  count: number
}

function summarize(messages: Message[]): ActivitySummary {
  let activeLabel: string | null = null
  let awaitingApproval = false
  let count = 0

  for (const message of messages) {
    if (message.content.role !== 'tool_call') continue
    count += 1
    const { status, tool, args } = message.content.data
    if (status === 'approval-requested') awaitingApproval = true
    if (!settledStatuses.has(status)) activeLabel = humanizeToolName(tool, args)
  }

  return { activeLabel, awaitingApproval, count: count || messages.length }
}

/**
 * Collapses a run of consecutive tool messages into one expandable row so a long
 * agent turn does not push the conversation off screen.
 */
export function ToolActivityGroup({
  messages,
  live,
  children
}: {
  messages: Message[]
  live: boolean
  children: React.ReactNode
}): React.JSX.Element {
  const { t } = useT('common')
  const [expanded, setExpanded] = useState(false)
  const { activeLabel, awaitingApproval, count } = summarize(messages)

  // Approval prompts live inside the child rows, so the group cannot hide them.
  const open = expanded || awaitingApproval
  // A backend that never reports a tool result would leave the last call looking
  // busy forever, so the turn itself decides whether this group is still working.
  const running = live && activeLabel !== null && !awaitingApproval
  const activeHeadline = running || awaitingApproval ? activeLabel : null
  const label = activeHeadline ?? t('agentChat.toolActivity.steps', { count })
  const statusLabel = awaitingApproval
    ? t('agentChat.toolActivity.awaitingApproval')
    : running
      ? t('agentChat.toolActivity.running')
      : t('agentChat.toolActivity.done')

  return (
    <Collapsible open={open} onOpenChange={setExpanded} className="rounded-md text-xs">
      <CollapsibleTrigger
        data-testid="agent-tool-group"
        className="inline-flex max-w-full items-center gap-1.5 py-1 text-start text-muted-foreground hover:text-foreground"
      >
        <ChevronRight
          className={cn('size-3 shrink-0 transition-transform', open && 'rotate-90')}
          aria-hidden="true"
        />
        <span className="truncate">{label}</span>
        {activeHeadline !== null && count > 1 && (
          <span className="shrink-0 tabular-nums opacity-60">{count}</span>
        )}
        {running && <ThinkingPixels />}
        <span className="sr-only">{statusLabel}</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="ms-1.5 space-y-1 border-s border-border ps-3">
        {children}
      </CollapsibleContent>
    </Collapsible>
  )
}
