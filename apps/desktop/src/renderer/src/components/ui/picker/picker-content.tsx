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
        widthClass,
        className
      )}
      style={typeof width === 'number' ? { width: `${width}px` } : undefined}
      onClick={(e) => e.stopPropagation()}
      {...props}
    >
      <div className="flex flex-col text-[13px] leading-4 [font-synthesis:none]">{children}</div>
    </PopoverContent>
  )
})
PickerContent.displayName = 'PickerContent'
