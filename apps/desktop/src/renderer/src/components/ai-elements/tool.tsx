import type { ComponentProps } from 'react'
import { isValidElement } from 'react'

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { ChevronDown } from '@/lib/icons'
import { cn } from '@/lib/utils'

export type ToolState =
  | 'approved'
  | 'completed'
  | 'denied'
  | 'failed'
  | 'pending'
  | 'input-streaming'
  | 'approval-requested'
  | 'approval-responded'
  | 'input-available'
  | 'output-available'
  | 'output-error'
  | 'output-denied'

const statusLabels: Record<ToolState, string> = {
  approved: 'Approved',
  'approval-requested': 'Awaiting approval',
  'approval-responded': 'Responded',
  completed: 'Completed',
  denied: 'Denied',
  failed: 'Failed',
  'input-available': 'Running',
  'input-streaming': 'Pending',
  'output-available': 'Completed',
  'output-denied': 'Denied',
  'output-error': 'Error',
  pending: 'Pending'
}

export type ToolProps = ComponentProps<typeof Collapsible>

export function Tool({ className, ...props }: ToolProps): React.JSX.Element {
  return (
    <Collapsible
      className={cn(
        'group rounded-md border border-sidebar-border bg-sidebar-accent/40 text-xs',
        className
      )}
      {...props}
    />
  )
}

export type ToolHeaderProps = ComponentProps<typeof CollapsibleTrigger> & {
  active?: boolean
  state: ToolState
  title?: string
  type?: string
}

export function ToolHeader({
  active = false,
  className,
  state,
  title,
  type,
  ...props
}: ToolHeaderProps): React.JSX.Element {
  const label = title ?? type?.replace(/^tool-/, '') ?? 'tool'

  return (
    <CollapsibleTrigger
      className={cn(
        'flex w-full items-center justify-between gap-2 px-3 py-1.5 text-start',
        className
      )}
      {...props}
    >
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="shrink-0 text-muted-foreground" aria-hidden="true">
          &gt;
        </span>
        <span
          className={cn(
            'truncate font-medium text-foreground',
            active && 'agent-tool-label-active'
          )}
        >
          {label}
        </span>
        <span className="sr-only">{statusLabels[state]}</span>
      </span>
      <ChevronDown
        className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180"
        aria-hidden="true"
      />
    </CollapsibleTrigger>
  )
}

export type ToolContentProps = ComponentProps<typeof CollapsibleContent>

export function ToolContent({ className, ...props }: ToolContentProps): React.JSX.Element {
  return <CollapsibleContent className={cn('space-y-3 px-3 pb-3', className)} {...props} />
}

export type ToolInputProps = ComponentProps<'div'> & {
  input: unknown
  label?: string
}

export type ToolTextProps = ComponentProps<'div'> & {
  label?: string
  value: string
}

export function ToolText({ className, label, value, ...props }: ToolTextProps): React.JSX.Element {
  return (
    <div className={cn('space-y-2 overflow-hidden', className)} {...props}>
      <h4 className="font-medium text-muted-foreground text-xs uppercase">{label ?? 'Tool'}</h4>
      <pre className="max-h-36 overflow-auto rounded-md bg-background p-2 text-muted-foreground">
        {value}
      </pre>
    </div>
  )
}

export function ToolInput({
  className,
  input,
  label,
  ...props
}: ToolInputProps): React.JSX.Element {
  return (
    <div className={cn('space-y-2 overflow-hidden', className)} {...props}>
      <h4 className="font-medium text-muted-foreground text-xs uppercase">{label ?? 'Input'}</h4>
      <pre className="max-h-36 overflow-auto rounded-md bg-background p-2 text-muted-foreground">
        {JSON.stringify(input, null, 2)}
      </pre>
    </div>
  )
}

export type ToolOutputProps = ComponentProps<'div'> & {
  errorText?: string
  output?: unknown
}

export function ToolOutput({
  className,
  errorText,
  output,
  ...props
}: ToolOutputProps): React.JSX.Element | null {
  if (errorText === undefined && output === undefined) return null

  const renderedOutput =
    typeof output === 'string' || isValidElement(output) ? output : JSON.stringify(output, null, 2)

  return (
    <div className={cn('space-y-2', className)} {...props}>
      <h4 className="font-medium text-muted-foreground text-xs uppercase">
        {errorText ? 'Error' : 'Result'}
      </h4>
      <pre
        className={cn(
          'max-h-36 overflow-auto rounded-md bg-background p-2',
          errorText ? 'text-destructive' : 'text-muted-foreground'
        )}
      >
        {errorText ?? renderedOutput}
      </pre>
    </div>
  )
}
