import * as React from 'react'
import { Plus } from '@/lib/icons'
import { cn } from '@/lib/utils'

type AddTagButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement>

export const AddTagButton = React.forwardRef<HTMLButtonElement, AddTagButtonProps>(
  ({ className, disabled, ...props }, ref) => {
    return (
      <button
        ref={ref}
        type="button"
        disabled={disabled}
        aria-label="Add tag"
        className={cn(
          'flex items-center justify-center',
          'rounded-full shrink-0 size-6',
          'border-[1.5px] border-dashed border-border',
          'text-text-tertiary',
          'transition-all duration-150',
          'hover:border-muted-foreground hover:text-muted-foreground',
          'focus:outline-none',
          'disabled:pointer-events-none disabled:opacity-50',
          className
        )}
        {...props}
      >
        <Plus className="h-3 w-3" strokeWidth={2.5} />
      </button>
    )
  }
)
AddTagButton.displayName = 'AddTagButton'
