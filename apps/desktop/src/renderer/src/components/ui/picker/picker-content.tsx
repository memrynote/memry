import * as React from 'react'
import { PopoverContent } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { usePickerContext } from './types'

export interface PickerContentProps extends React.ComponentPropsWithoutRef<typeof PopoverContent> {
  width?: 'auto' | 'trigger' | number
}

export const PickerContent = React.forwardRef<
  React.ComponentRef<typeof PopoverContent>,
  PickerContentProps
>(({ width, className, children, ...props }, ref) => {
  const { contentId } = usePickerContext()
  const widthClass =
    width === 'auto'
      ? 'w-auto'
      : width === 'trigger'
        ? 'w-(--radix-popover-trigger-width)'
        : typeof width === 'number'
          ? undefined
          : 'w-72'

  return (
    <PopoverContent
      ref={ref}
      id={props.id ?? contentId}
      data-slot="picker-content"
      className={cn(
        'p-0 rounded-md overflow-clip shadow-[var(--shadow-card-hover)]',
        // Radix anchors the popover to its trigger, so a trigger low in the
        // window gets little room below it. Cap at the height Radix measured
        // and lay out as a column so the body can shrink and scroll rather than
        // be swallowed by `overflow-clip`.
        'flex flex-col max-h-(--radix-popover-content-available-height)',
        widthClass,
        className
      )}
      style={typeof width === 'number' ? { width: `${width}px` } : undefined}
      onClick={(e) => e.stopPropagation()}
      {...props}
    >
      <div className="flex flex-col min-h-0 text-[13px] leading-4 [font-synthesis:none]">
        {children}
      </div>
    </PopoverContent>
  )
})
PickerContent.displayName = 'PickerContent'
