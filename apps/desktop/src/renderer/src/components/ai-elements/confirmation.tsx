import type { ComponentProps } from 'react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export type ConfirmationProps = ComponentProps<'div'> & {
  state: 'approved' | 'completed' | 'denied' | 'failed' | 'pending'
}

export function Confirmation({
  className,
  state,
  ...props
}: ConfirmationProps): React.JSX.Element | null {
  if (state !== 'pending') return null

  return (
    <div
      className={cn(
        'flex flex-col gap-2 rounded-md border border-sidebar-border bg-background p-3',
        className
      )}
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
