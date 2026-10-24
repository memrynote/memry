import { forwardRef, type ComponentPropsWithoutRef, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * The sidebar footer's single row: sync, the vault pill, help and settings, set off
 * from the list above by a full-width divider rather than a filled surface.
 */
export function FooterDock({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <div
      data-testid="sidebar-footer-dock"
      className="-mx-2 flex items-center gap-0.5 border-t border-sidebar-border px-2 pt-2"
    >
      {children}
    </div>
  )
}

export type DockBadgeTone = 'success' | 'warning' | 'destructive' | 'tint' | 'info'

const BADGE_TONE: Record<DockBadgeTone, string> = {
  success: 'bg-green-500',
  warning: 'bg-amber-500',
  destructive: 'bg-red-500',
  tint: 'bg-[var(--tint)]',
  info: 'bg-blue-500'
}

interface DockButtonProps extends ComponentPropsWithoutRef<'button'> {
  /** Small status dot on the icon's bottom end corner. */
  badge?: DockBadgeTone | null
}

/**
 * 28px icon button inside the dock. Open menus/popovers (Radix `data-state=open`)
 * lift it onto a raised surface so the user can see which control owns the panel.
 * Forwards ref so it can be a Radix trigger.
 */
export const DockButton = forwardRef<HTMLButtonElement, DockButtonProps>(function DockButton(
  { badge, className, children, ...props },
  ref
) {
  return (
    <button
      ref={ref}
      type="button"
      data-slot="dock-button"
      className={cn(
        'relative flex size-7 shrink-0 items-center justify-center rounded-[7px] text-muted-foreground transition-colors',
        'hover:bg-background/70 hover:text-foreground',
        'data-[state=open]:bg-background data-[state=open]:text-foreground data-[state=open]:shadow-xs',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--tint-ring)]',
        '[&_svg]:size-4',
        className
      )}
      {...props}
    >
      {children}
      {badge && (
        <span
          aria-hidden="true"
          data-testid="dock-badge"
          data-tone={badge}
          className={cn(
            'absolute end-1 bottom-[5px] size-[7px] rounded-full ring-2 ring-sidebar',
            BADGE_TONE[badge]
          )}
        />
      )}
    </button>
  )
})
