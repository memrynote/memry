import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { PopoverTrigger } from '@/components/ui/popover'
import { ChevronDown } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { usePickerContext } from './types'

const pickerTriggerVariants = cva(
  'inline-flex items-center gap-2 whitespace-nowrap transition-all disabled:pointer-events-none disabled:opacity-50 outline-none shrink-0 cursor-pointer',
  {
    variants: {
      variant: {
        button:
          'justify-between rounded-md border bg-background px-3 py-2 h-9 text-sm font-medium shadow-xs hover:bg-accent dark:bg-input/30 dark:border-input dark:hover:bg-input/50',
        icon: 'justify-center rounded-md size-8 text-muted-foreground hover:bg-accent hover:text-accent-foreground',
        badge: 'rounded-sm py-0.5 px-2 text-[11px] font-medium leading-4 hover:opacity-80',
        ghost: 'rounded-md px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground',
        inline: 'rounded-sm p-0.5 hover:bg-accent/80 focus-visible:outline-none'
      }
    },
    defaultVariants: {
      variant: 'button'
    }
  }
)

type PickerTriggerVariantProps = VariantProps<typeof pickerTriggerVariants>

export interface PickerTriggerProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, PickerTriggerVariantProps {
  chevron?: boolean
  asChild?: boolean
}

export const PickerTrigger = React.forwardRef<HTMLButtonElement, PickerTriggerProps>(
  ({ variant, chevron = false, asChild = false, className, children, onClick, ...props }, ref) => {
    const { open } = usePickerContext()

    const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
      e.stopPropagation()
      onClick?.(e)
    }

    if (asChild) {
      return <PopoverTrigger asChild>{children}</PopoverTrigger>
    }

    return (
      <PopoverTrigger asChild>
        <button
          ref={ref}
          type="button"
          role="combobox"
          aria-expanded={open}
          data-slot="picker-trigger"
          className={cn(pickerTriggerVariants({ variant }), className)}
          onClick={handleClick}
          {...props}
        >
          {children}
          {chevron && (
            <ChevronDown
              className={cn(
                'size-3.5 shrink-0 opacity-50 transition-transform',
                open && 'rotate-180'
              )}
            />
          )}
        </button>
      </PopoverTrigger>
    )
  }
)
PickerTrigger.displayName = 'PickerTrigger'

export { pickerTriggerVariants }
