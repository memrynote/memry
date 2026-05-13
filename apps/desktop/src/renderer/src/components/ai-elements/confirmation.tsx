import type { ComponentProps, ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export type ConfirmationProps = ComponentProps<'div'> & {
  approval?: {
    approved?: boolean
    id?: string
    reason?: string
  }
  state:
    | 'approved'
    | 'completed'
    | 'denied'
    | 'failed'
    | 'pending'
    | 'approval-requested'
    | 'approval-responded'
    | 'input-available'
    | 'input-streaming'
    | 'output-available'
    | 'output-denied'
    | 'output-error'
}

export function Confirmation({
  approval,
  className,
  state,
  ...props
}: ConfirmationProps): React.JSX.Element | null {
  const visible =
    state === 'pending' ||
    state === 'approval-requested' ||
    state === 'approval-responded' ||
    state === 'output-available' ||
    state === 'output-denied' ||
    state === 'denied' ||
    state === 'completed' ||
    state === 'failed'
  if (!visible) return null

  return (
    <div
      className={cn(
        'flex flex-col gap-2 rounded-md border border-sidebar-border bg-background p-3',
        className
      )}
      data-approved={approval?.approved}
      {...props}
    />
  )
}

export type ConfirmationTitleProps = ComponentProps<'p'>

export function ConfirmationTitle({
  className,
  ...props
}: ConfirmationTitleProps): React.JSX.Element {
  return <p className={cn('text-sm text-foreground', className)} {...props} />
}

export type ConfirmationRequestProps = ComponentProps<'span'>

export function ConfirmationRequest({
  className,
  ...props
}: ConfirmationRequestProps): React.JSX.Element {
  return <span className={className} {...props} />
}

export type ConfirmationAcceptedProps = ComponentProps<'span'> & {
  children: ReactNode
}

export function ConfirmationAccepted({
  className,
  ...props
}: ConfirmationAcceptedProps): React.JSX.Element {
  return <span className={cn('inline-flex items-center gap-1.5', className)} {...props} />
}

export type ConfirmationRejectedProps = ComponentProps<'span'> & {
  children: ReactNode
}

export function ConfirmationRejected({
  className,
  ...props
}: ConfirmationRejectedProps): React.JSX.Element {
  return <span className={cn('inline-flex items-center gap-1.5', className)} {...props} />
}

export type ConfirmationActionsProps = ComponentProps<'div'>

export function ConfirmationActions({
  className,
  ...props
}: ConfirmationActionsProps): React.JSX.Element {
  return (
    <div className={cn('flex flex-wrap items-center justify-end gap-2', className)} {...props} />
  )
}

export type ConfirmationActionProps = ComponentProps<typeof Button>

export function ConfirmationAction({
  className,
  ...props
}: ConfirmationActionProps): React.JSX.Element {
  return <Button className={cn('h-8 px-3 text-sm', className)} type="button" {...props} />
}
