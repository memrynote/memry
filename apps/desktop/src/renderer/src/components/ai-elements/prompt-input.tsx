import type { ComponentProps, FormEvent } from 'react'

import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'

export interface PromptInputMessage {
  text: string
}

export type PromptInputProps = Omit<ComponentProps<'form'>, 'onSubmit'> & {
  onSubmit: (message: PromptInputMessage, event: FormEvent<HTMLFormElement>) => void
}

export function PromptInput({
  className,
  onSubmit,
  ...props
}: PromptInputProps): React.JSX.Element {
  return (
    <form
      className={cn('w-full', className)}
      onSubmit={(event) => {
        event.preventDefault()
        const formData = new FormData(event.currentTarget)
        const value = formData.get('message')
        onSubmit({ text: typeof value === 'string' ? value : '' }, event)
      }}
      {...props}
    />
  )
}

export type PromptInputTextareaProps = ComponentProps<typeof Textarea>

export function PromptInputTextarea({
  className,
  ...props
}: PromptInputTextareaProps): React.JSX.Element {
  return (
    <Textarea
      name="message"
      className={cn(
        'field-sizing-content max-h-48 min-h-20 resize-none bg-background text-sm',
        className
      )}
      {...props}
    />
  )
}

export type PromptInputActionsProps = ComponentProps<'div'>

export function PromptInputActions({
  className,
  ...props
}: PromptInputActionsProps): React.JSX.Element {
  return <div className={cn('flex items-end gap-2', className)} {...props} />
}

export type PromptInputSubmitProps = ComponentProps<typeof Button>

export function PromptInputSubmit({
  size = 'icon',
  type = 'submit',
  ...props
}: PromptInputSubmitProps): React.JSX.Element {
  return <Button size={size} type={type} {...props} />
}
