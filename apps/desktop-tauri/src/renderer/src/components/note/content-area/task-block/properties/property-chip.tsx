import { forwardRef, type ComponentPropsWithoutRef, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * The popovers behind the chips are portaled out of the editor DOM, but React
 * still bubbles their events up the component tree, through the block and
 * into the note editor's own handlers. A key typed into a tag search or the
 * description editor is that popover's alone.
 */
export const stopKeyPropagation = (event: React.KeyboardEvent): void => {
  event.stopPropagation()
}

/**
 * Chip popovers are capped at the height Radix measured and laid out as a
 * column, so tall content shrinks and scrolls instead of running off screen
 * (see InteractiveDueDateBadge for the long version of why).
 */
export const CHIP_POPOVER_CLASS =
  'w-auto p-0 rounded-md overflow-clip flex flex-col max-h-(--radix-popover-content-available-height)'

export type PropertyChipTone = 'default' | 'overdue' | 'ghost'

interface PropertyChipProps extends ComponentPropsWithoutRef<'button'> {
  icon?: ReactNode
  tone?: PropertyChipTone
}

/**
 * One property on the task row. A plain button so Radix triggers can wrap it
 * with `asChild`; `data-state="open"` from the trigger keeps it pressed while
 * its picker is up.
 */
export const PropertyChip = forwardRef<HTMLButtonElement, PropertyChipProps>(function PropertyChip(
  { icon, tone = 'default', className, children, ...props },
  ref
) {
  return (
    <button
      ref={ref}
      type="button"
      className={cn(
        'flex h-5 max-w-44 shrink-0 cursor-pointer items-center gap-1 rounded-[5px] border px-1.5',
        'text-[11px] font-medium leading-3.5 whitespace-nowrap',
        'transition-colors duration-100 focus-visible:outline-none',
        'focus-visible:ring-1 focus-visible:ring-text-tertiary',
        tone === 'ghost'
          ? 'cursor-default border-dashed border-foreground/20 text-text-tertiary'
          : 'border-border text-text-secondary hover:bg-surface-active data-[state=open]:border-foreground/20 data-[state=open]:bg-surface-active',
        tone === 'overdue' && 'border-destructive/30 text-destructive',
        className
      )}
      {...props}
    >
      {icon}
      {children !== undefined && children !== null && (
        <span className="min-w-0 truncate">{children}</span>
      )}
    </button>
  )
})
