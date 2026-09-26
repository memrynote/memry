import { Children, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

export const ACCENT_SWITCH = 'data-[state=checked]:bg-[var(--tint)]'

export const COMPACT_SELECT =
  'h-auto w-auto shrink-0 rounded-md py-1 px-2.5 gap-1.5 bg-transparent border-border text-xs/4 text-foreground shadow-none hover:bg-muted/40'

/** Hairline list surface shared by settings groups and drill-in lists. */
export const SETTINGS_LIST = 'flex flex-col border-t border-border'

/** Sentence-case group label that sits above a hairline list. */
export const SETTINGS_GROUP_LABEL = 'pb-1.5 font-semibold text-xs/4 text-foreground'

/**
 * Settings search marks the matched row with `data-search-hit`: accent bar on
 * the start edge plus a faint accent wash, as in the search design.
 */
const SEARCH_HIT_ROW =
  'transition-colors duration-200 data-[search-hit]:bg-[color-mix(in_srgb,var(--tint)_9%,transparent)] data-[search-hit]:shadow-[inset_2px_0_0_var(--tint)] rtl:data-[search-hit]:shadow-[inset_-2px_0_0_var(--tint)] data-[search-hit]:ps-2.5 data-[search-hit]:pe-2'

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

interface SettingsGroupProps {
  label?: string
  children: ReactNode
}

export function SettingsGroup({ label, children }: SettingsGroupProps) {
  const items = Children.toArray(children).filter(Boolean)

  return (
    <div className="flex flex-col pb-8">
      {label && (
        <h4 data-settings-label={label} className={cn(SETTINGS_GROUP_LABEL, SEARCH_HIT_GROUP)}>
          {label}
        </h4>
      )}
      <div className="flex flex-col">
        {items.map((child, i) => (
          <div key={i} className="border-b border-border">
            {child}
          </div>
        ))}
      </div>
    </div>
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
