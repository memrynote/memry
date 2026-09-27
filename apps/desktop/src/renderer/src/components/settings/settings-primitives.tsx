import { Children, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

export const ACCENT_SWITCH = 'data-[state=checked]:bg-[var(--tint)]'

export const COMPACT_SELECT =
  'h-auto w-auto shrink-0 rounded-md py-1 px-2.5 gap-1.5 bg-transparent border-border text-xs/4 text-foreground shadow-none hover:bg-surface-active'

/**
 * Rounded card that groups settings rows. Direct children are rows; each one
 * after the first gets an inset hairline above it. Custom lists use this so
 * every settings page shares one surface.
 *
 * On dark themes `--muted` equals `--card`, so tracks, pills and hover fills
 * painted with `bg-muted` would vanish on the card. Inside it, muted steps up
 * to the active surface.
 */
export const SETTINGS_CARD =
  'flex flex-col rounded-xl border border-border bg-card px-4 [--muted:var(--surface-active)] [&>*+*]:border-t [&>*+*]:border-border'

/** Group heading that sits above a settings card. */
export const SETTINGS_GROUP_LABEL = 'pb-2.5 font-medium text-[13px]/4 text-foreground'

/** Segmented control track and item, tuned to read on the card surface. */
export const SEGMENTED = 'gap-0 rounded-[7px] bg-surface-active p-0.5'
export const SEGMENT_ITEM =
  'h-auto min-w-0 rounded-[5px] border-none py-0.75 px-2.5 text-xs/4 text-muted-foreground shadow-none hover:bg-transparent data-[state=on]:bg-card data-[state=on]:font-medium data-[state=on]:text-foreground data-[state=on]:shadow-[0_1px_2px_rgb(0_0_0/0.08)]'

/**
 * Settings search marks the matched row with `data-search-hit`: accent bar on
 * the start edge plus a faint accent wash. Rows sit inside the card's inline
 * padding, so the hit bleeds out to the card edge.
 */
const SEARCH_HIT_ROW =
  'transition-colors duration-200 data-[search-hit]:bg-[color-mix(in_srgb,var(--tint)_9%,transparent)] data-[search-hit]:shadow-[inset_2px_0_0_var(--tint)] rtl:data-[search-hit]:shadow-[inset_-2px_0_0_var(--tint)] data-[search-hit]:-mx-4 data-[search-hit]:px-4'

const SEARCH_HIT_GROUP = 'transition-colors duration-200 data-[search-hit]:text-[var(--tint)]'

interface SettingsHeaderProps {
  title: string
  subtitle: string
  action?: ReactNode
}

export function SettingsHeader({ title, subtitle, action }: SettingsHeaderProps) {
  return (
    <div className="flex items-start justify-between pb-8 gap-4">
      <div className="flex flex-col gap-1">
        <h3 className="font-semibold text-[22px]/7 tracking-[-0.01em] text-foreground">{title}</h3>
        <p className="text-[13px]/5 text-muted-foreground">{subtitle}</p>
      </div>
      {action}
    </div>
  )
}

interface SettingsGroupHeadingProps {
  label: string
  description?: string
  /** Sits at the heading's inline end, e.g. an Add button for the list below. */
  action?: ReactNode
}

/** Label (and optional line of context) above a settings card. */
export function SettingsGroupHeading({ label, description, action }: SettingsGroupHeadingProps) {
  return (
    <div className="flex items-end justify-between gap-4 pb-2.5">
      <div className="flex min-w-0 flex-col gap-0.5">
        <h4
          data-settings-label={label}
          className={cn('text-[13px]/4 font-medium text-foreground', SEARCH_HIT_GROUP)}
        >
          {label}
        </h4>
        {description && <p className="text-xs/4 text-muted-foreground">{description}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  )
}

interface SettingsGroupProps {
  label?: string
  description?: string
  action?: ReactNode
  children: ReactNode
}

/** A titled group of settings rows on a card. */
export function SettingsGroup({ label, description, action, children }: SettingsGroupProps) {
  const items = Children.toArray(children).filter(Boolean)

  return (
    <section className="flex flex-col pb-9">
      {label && <SettingsGroupHeading label={label} description={description} action={action} />}
      {/* Clips a search hit, which bleeds to the card edge, at the rounded corners. */}
      <div className={cn(SETTINGS_CARD, 'overflow-hidden')}>
        {items.map((child, i) => (
          <div key={i}>{child}</div>
        ))}
      </div>
    </section>
  )
}

interface SettingRowProps {
  label: string
  description?: string
  children: ReactNode
  className?: string
  'data-testid'?: string
}

export function SettingRow({
  label,
  description,
  children,
  className,
  'data-testid': testId
}: SettingRowProps) {
  return (
    <div
      data-testid={testId}
      data-settings-label={label}
      className={cn(
        'flex items-center justify-between min-h-11 py-2.5 shrink-0',
        SEARCH_HIT_ROW,
        className
      )}
    >
      <div className="flex flex-col gap-0.5 min-w-0">
        <span className="text-[13px]/4 text-foreground">{label}</span>
        {description && <span className="text-xs/4 text-muted-foreground">{description}</span>}
      </div>
      <div className="shrink-0 ms-4">{children}</div>
    </div>
  )
}

export function SettingRowTall({
  label,
  description,
  children,
  className,
  'data-testid': testId
}: SettingRowProps) {
  return (
    <div
      data-testid={testId}
      data-settings-label={label}
      className={cn('flex flex-col gap-2.5 min-h-14 py-3 shrink-0', SEARCH_HIT_ROW, className)}
    >
      <div className="flex items-center justify-between">
        <div className="flex flex-col gap-0.5 min-w-0">
          <span className="text-[13px]/4 text-foreground">{label}</span>
          {description && <span className="text-xs/4 text-muted-foreground">{description}</span>}
        </div>
      </div>
      {children}
    </div>
  )
}
