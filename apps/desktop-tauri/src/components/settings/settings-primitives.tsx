import { Children, type ReactNode } from 'react'

export const ACCENT_SWITCH = 'data-[state=checked]:bg-[var(--tint)]'

export const COMPACT_SELECT =
  'h-auto w-auto shrink-0 rounded-md py-1 px-2.5 gap-1.5 bg-muted/50 border-border text-xs/4 text-muted-foreground shadow-none'

interface SettingsHeaderProps {
  title: string
  subtitle: string
  action?: ReactNode
}

export function SettingsHeader({ title, subtitle, action }: SettingsHeaderProps) {
  return (
    <div className="flex items-start justify-between pb-6 gap-4">
      <div className="flex flex-col gap-0.5">
        <h3 className="font-semibold text-base/5 tracking-[-0.01em] text-foreground">{title}</h3>
        <p className="text-xs/4 text-muted-foreground">{subtitle}</p>
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
    <div className="flex flex-col pb-6">
      {label && (
        <h4 className="uppercase pb-2 text-muted-foreground font-medium text-[11px]/3.5 tracking-[0.05em]">
          {label}
        </h4>
      )}
      <div className="flex flex-col rounded-lg overflow-clip border border-border">
        {items.map((child, i) => (
          <div key={i}>
            {i > 0 && <div className="h-px bg-border" />}
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
}

export function SettingRow({ label, description, children }: SettingRowProps) {
  return (
    <div className="flex items-center justify-between h-11 py-3 px-4 shrink-0">
      <div className="flex flex-col gap-px min-w-0">
        <span className="font-medium text-[13px]/4 text-foreground">{label}</span>
        {description && (
          <span className="text-xs/4 text-muted-foreground truncate">{description}</span>
        )}
      </div>
      <div className="shrink-0 ml-4">{children}</div>
    </div>
  )
}

export function SettingRowTall({ label, description, children }: SettingRowProps) {
  return (
    <div className="flex flex-col gap-2 min-h-14 py-3 px-4 shrink-0">
      <div className="flex items-center justify-between">
        <div className="flex flex-col gap-px min-w-0">
          <span className="font-medium text-[13px]/4 text-foreground">{label}</span>
          {description && (
            <span className="text-xs/4 text-muted-foreground truncate">{description}</span>
          )}
        </div>
      </div>
      {children}
    </div>
  )
}
