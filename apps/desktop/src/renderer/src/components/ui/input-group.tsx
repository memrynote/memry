import * as React from 'react'

import { cn } from '@/lib/utils'

const InputGroup = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => {
    return (
      <div
        ref={ref}
        className={cn(
          'flex h-9 w-full items-center overflow-hidden rounded-md border border-input bg-transparent text-sm shadow-xs transition-[color,box-shadow]',
          className
        )}
        {...props}
      />
    )
  }
)
InputGroup.displayName = 'InputGroup'

const InputGroupInput = React.forwardRef<HTMLInputElement, React.ComponentProps<'input'>>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        ref={ref}
        className={cn(
          'h-full flex-1 bg-transparent px-3 py-1 text-base outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50 md:text-sm',
          className
        )}
        {...props}
      />
    )
  }
)
InputGroupInput.displayName = 'InputGroupInput'

const InputGroupAddon = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & {
    align?: 'inline-start' | 'inline-end'
  }
>(({ className, align = 'inline-start', ...props }, ref) => {
  return (
    <div
      ref={ref}
      className={cn(
        'flex h-full items-center px-2 text-muted-foreground',
        align === 'inline-end' && 'ml-auto',
        className
      )}
      {...props}
    />
  )
})
InputGroupAddon.displayName = 'InputGroupAddon'

export { InputGroup, InputGroupInput, InputGroupAddon }
