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

/**
 * Reads from the inline start, not the end. The action the user takes most is
 * first under the thing they just read, and the destructive one is pushed to
 * the far end by a spacer so it cannot be hit on the way to Approve.
 */
export function ConfirmationActions({
  className,
  ...props
}: ConfirmationActionsProps): React.JSX.Element {
  return <div className={cn('flex flex-wrap items-center gap-1.5', className)} {...props} />
}

export function ConfirmationActionsSpacer(): React.JSX.Element {
  return <div aria-hidden className="grow" />
}

/**
 * `primary` is the tint, because approving is the creation action on this card
 * and the tint is what Memry uses for those. `quiet-destructive` deliberately
 * has no fill and no border: rejecting is one click and the card already says
 * what it would undo, so a red block would shout louder than the change it is
 * about.
 */
export type ConfirmationActionTone = 'primary' | 'secondary' | 'quiet-destructive'

const TONE_CLASSES: Record<ConfirmationActionTone, string> = {
  primary: 'bg-tint text-tint-foreground hover:bg-tint-hover px-[13px] font-medium',
  secondary:
    'border border-border bg-transparent text-text-secondary hover:bg-surface hover:text-foreground px-3',
  'quiet-destructive':
    'bg-transparent text-destructive hover:bg-destructive/10 hover:text-destructive px-2.5'
}

export type ConfirmationActionProps = Omit<ComponentProps<typeof Button>, 'variant'> & {
  tone?: ConfirmationActionTone
}

export function ConfirmationAction({
  className,
  tone = 'secondary',
  ...props
}: ConfirmationActionProps): React.JSX.Element {
  return (
    <Button
      variant="ghost"
      className={cn(
        'h-auto rounded-[7px] py-1.5 text-xs font-normal',
        TONE_CLASSES[tone],
        className
      )}
      type="button"
      {...props}
    />
  )
}
