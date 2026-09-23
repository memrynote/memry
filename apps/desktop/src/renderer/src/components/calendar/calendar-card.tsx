/**
 * Shared anatomy of the calendar detail cards (task and event popovers):
 *
 *   header      type dot + label, quiet icon actions on the end
 *   body        title, then sections split by hairlines
 *   action bar  the primary action on the start, the secondary on the end,
 *               each with the key that triggers it
 *
 * The card stays calm on purpose. Colour appears only in the type dot, the
 * checkbox and at most one hue-filled button.
 */
import type { CSSProperties, ReactNode } from 'react'
import { Kbd } from '@/components/ui/kbd'
import { isMac } from '@/hooks/use-keyboard-shortcuts-base'
import { cn } from '@/lib/utils'

/** Popover shell classes shared by the calendar detail cards. */
export const CALENDAR_CARD_CLASS =
  'fixed z-50 flex flex-col overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-[0_1px_2px_rgba(0,0,0,0.06),0_12px_32px_rgba(0,0,0,0.12)] outline-none dark:shadow-[0_0_0_1px_rgba(0,0,0,0.4),0_16px_40px_rgba(0,0,0,0.55)]'

export const MOD_KEY_LABEL = isMac ? '⌘' : 'Ctrl'

/** True for ⌘↵ on macOS and Ctrl+↵ elsewhere. */
export function isModEnter(event: React.KeyboardEvent): boolean {
  return event.key === 'Enter' && (isMac ? event.metaKey : event.ctrlKey)
}

export function CalendarCardHeader({
  dotStyle,
  label,
  actions
}: {
  dotStyle: CSSProperties
  label: ReactNode
  actions?: ReactNode
}): React.JSX.Element {
  return (
    <div className="flex h-9 shrink-0 items-center justify-between gap-2 ps-3.5 pe-1.5">
      <div className="flex min-w-0 items-center gap-1.5">
        <span aria-hidden className="size-2 shrink-0 rounded-[2px]" style={dotStyle} />
        <span className="truncate text-[11px] font-medium text-muted-foreground">{label}</span>
      </div>
      {actions && <div className="flex shrink-0 items-center gap-0.5">{actions}</div>}
    </div>
  )
}

export const CARD_ICON_BUTTON_CLASS =
  'inline-flex size-7 items-center justify-center rounded-[5px] text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-(--tint-ring)'

export function CalendarCardSection({
  className,
  children,
  ...props
}: React.ComponentProps<'div'>): React.JSX.Element {
  return (
    <div className={cn('border-t border-border/70', className)} {...props}>
      {children}
    </div>
  )
}

export function CalendarCardActionBar({
  start,
  end
}: {
  start?: ReactNode
  end?: ReactNode
}): React.JSX.Element {
  return (
    <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-t border-border/70 bg-foreground/[0.02] ps-2 pe-1.5">
      <div className="flex min-w-0 items-center gap-1">{start}</div>
      <div className="flex min-w-0 items-center gap-1">{end}</div>
    </div>
  )
}

/** An action bar button: label plus the keys that trigger it. */
export function CalendarCardAction({
  label,
  keys,
  emphasis = false,
  className,
  ...props
}: Omit<React.ComponentProps<'button'>, 'children'> & {
  label: string
  keys: string[]
  emphasis?: boolean
}): React.JSX.Element {
  return (
    <button
      type="button"
      className={cn(
        'inline-flex h-7 items-center gap-1.5 rounded-[5px] px-1.5 text-xs outline-none transition-colors',
        'hover:bg-accent focus-visible:ring-1 focus-visible:ring-(--tint-ring) disabled:pointer-events-none disabled:opacity-50',
        emphasis ? 'font-medium text-foreground' : 'text-muted-foreground hover:text-foreground',
        className
      )}
      {...props}
    >
      <span>{label}</span>
      <span aria-hidden className="inline-flex items-center gap-0.5">
        {keys.map((key) => (
          <Kbd
            key={key}
            className="h-[18px] min-w-[18px] border border-border bg-popover text-[11px]"
          >
            {key}
          </Kbd>
        ))}
      </span>
    </button>
  )
}
