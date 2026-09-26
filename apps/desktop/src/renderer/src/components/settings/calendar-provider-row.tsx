import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { useT } from '@memry/i18n/renderer'
import { Checkbox } from '@/components/ui/checkbox'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Switch } from '@/components/ui/switch'
import { ChevronRight } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { ACCENT_SWITCH } from '@/components/settings/settings-primitives'

export const CALENDAR_QUIET_BUTTON =
  'rounded-sm text-xs/4 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50'

export const CALENDAR_DESTRUCTIVE_BUTTON =
  'rounded-sm text-xs/4 text-destructive transition-colors hover:text-destructive/80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50'

export const CALENDAR_BORDERED_BUTTON =
  'h-7 shrink-0 rounded-md border border-border bg-transparent px-2.5 text-xs/4 font-medium text-foreground transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50'

/** Lets "+ Add calendar" ask a provider row to open and start its connect flow. */
export interface CalendarConnectRegistry {
  register: (providerId: string, handler: () => void) => () => void
}

const CalendarConnectRegistryContext = createContext<CalendarConnectRegistry | null>(null)

export const CalendarConnectRegistryProvider = CalendarConnectRegistryContext.Provider

export type CalendarStatusTone = 'ok' | 'warn' | 'error' | 'off'

const STATUS_DOT: Record<CalendarStatusTone, string> = {
  ok: 'bg-emerald-500',
  warn: 'bg-amber-500',
  error: 'bg-destructive',
  off: 'border border-muted-foreground/60'
}

export function CalendarStatusLabel({
  tone,
  label
}: {
  tone: CalendarStatusTone
  label: string
}): React.JSX.Element {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5">
      <span aria-hidden className={cn('size-1.5 shrink-0 rounded-full', STATUS_DOT[tone])} />
      <span>{label}</span>
    </span>
  )
}

interface CalendarProviderRowProps {
  providerId: string
  /** A letter or icon; `mono` sets it in the mono face (file extensions). */
  tile: ReactNode
  mono?: boolean
  name: string
  hint?: ReactNode
  /** Muted trailing text, e.g. the selected calendar count. */
  meta?: ReactNode
  /** The row's one primary action, shown outside the toggle. */
  action?: ReactNode
  /** Shown under the row whether or not it is expanded. */
  alert?: ReactNode
  defaultOpen?: boolean
  onConnectRequest?: () => void
  children?: ReactNode
  'data-testid'?: string
}

/**
 * One calendar service in Settings → Calendar: tile, name and status on the
 * row, its calendars and switches in the indented body below.
 */
export function CalendarProviderRow({
  providerId,
  tile,
  mono = false,
  name,
  hint,
  meta,
  action,
  alert,
  defaultOpen = false,
  onConnectRequest,
  children,
  'data-testid': testId
}: CalendarProviderRowProps): React.JSX.Element {
  // Null until the user toggles, so a row that becomes connected (or needs
  // attention) after mount still follows `defaultOpen`.
  const [openOverride, setOpenOverride] = useState<boolean | null>(null)
  const open = openOverride ?? defaultOpen
  const hasBody = Boolean(children)
  const rowRef = useRef<HTMLDivElement>(null)
  const onConnectRequestRef = useRef(onConnectRequest)
  useEffect(() => {
    onConnectRequestRef.current = onConnectRequest
  })

  const registry = useContext(CalendarConnectRegistryContext)
  useEffect(() => {
    if (!registry) return
    return registry.register(providerId, () => {
      setOpenOverride(true)
      rowRef.current?.scrollIntoView?.({ block: 'nearest' })
      onConnectRequestRef.current?.()
    })
  }, [registry, providerId])

  const heading = (
    <>
      <span
        aria-hidden
        className={cn(
          'flex size-7 shrink-0 items-center justify-center rounded-md border border-border text-xs/4 text-muted-foreground',
          mono ? 'font-mono' : 'font-semibold'
        )}
      >
        {tile}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5 text-start">
        <span className="truncate text-[13px]/4 text-foreground">{name}</span>
        {hint && (
          <span className="flex min-w-0 items-center gap-1 truncate text-xs/4 text-muted-foreground">
            {hint}
          </span>
        )}
      </span>
      {meta && <span className="shrink-0 text-xs/4 text-muted-foreground">{meta}</span>}
    </>
  )

  return (
    <Collapsible
      open={hasBody && open}
      onOpenChange={setOpenOverride}
      ref={rowRef}
      data-testid={testId}
    >
      <div className="flex min-h-14 items-center gap-3 py-2.5">
        {hasBody ? (
          <CollapsibleTrigger
            className="flex min-w-0 flex-1 items-center gap-3 rounded-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            aria-label={name}
          >
            {heading}
          </CollapsibleTrigger>
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-3">{heading}</div>
        )}
        {action}
        {hasBody && (
          <CollapsibleTrigger
            tabIndex={-1}
            aria-hidden
            className="flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground"
          >
            <ChevronRight
              className={cn(
                'size-3.5 transition-transform duration-(--duration-fast) motion-reduce:transition-none',
                open ? 'rotate-90' : 'rtl:rotate-180'
              )}
            />
          </CollapsibleTrigger>
        )}
      </div>
      {alert && <div className="ps-10 pb-2.5">{alert}</div>}
      {hasBody && (
        <CollapsibleContent className="flex flex-col gap-3 ps-10 pb-4">
          {children}
        </CollapsibleContent>
      )}
    </Collapsible>
  )
}

/** A hairline switch row inside an expanded provider. */
export function CalendarSwitchRow({
  label,
  description,
  checked,
  disabled,
  onCheckedChange,
  error,
  'data-testid': testId
}: {
  label: string
  description?: string
  checked: boolean
  disabled?: boolean
  onCheckedChange: (checked: boolean) => void
  error?: string | null
  'data-testid'?: string
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-4 border-t border-border pt-3">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-[13px]/4 text-foreground">{label}</span>
        {description && <p className="text-xs/4 text-muted-foreground">{description}</p>}
        {error && (
          <p role="alert" className="text-xs/4 text-destructive">
            {error}
          </p>
        )}
      </div>
      <Switch
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
        aria-label={label}
        className={ACCENT_SWITCH}
        data-testid={testId}
      />
    </div>
  )
}

/** One calendar in a provider: tint checkbox, colour dot, name, "Default" pill. */
export function CalendarCheckRow({
  id,
  title,
  color,
  checked,
  disabled,
  isDefault = false,
  onCheckedChange,
  trailing,
  children
}: {
  id?: string
  title: string
  color?: string | null
  checked: boolean
  disabled?: boolean
  isDefault?: boolean
  onCheckedChange: (checked: boolean) => void
  trailing?: ReactNode
  children?: ReactNode
}): React.JSX.Element {
  const { t } = useT('settings')
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex min-h-7 items-center justify-between gap-3">
        <label htmlFor={id} className="flex min-w-0 items-center gap-2 text-xs/4 text-foreground">
          <Checkbox
            id={id}
            checked={checked}
            disabled={disabled}
            onCheckedChange={(next) => onCheckedChange(next === true)}
            aria-label={title}
          />
          {color !== undefined && (
            <span
              aria-hidden
              className="size-2 shrink-0 rounded-full"
              style={{ backgroundColor: color ?? '#64748b' }}
            />
          )}
          <span className="truncate">{title}</span>
          {isDefault && (
            <span className="shrink-0 rounded-full bg-muted px-1.5 text-[11px]/4 text-muted-foreground">
              {t('calendar.v2.defaultPill')}
            </span>
          )}
        </label>
        {trailing && <div className="flex shrink-0 items-center gap-2">{trailing}</div>}
      </div>
      {children && <div className="ps-6">{children}</div>}
    </div>
  )
}

/** A compact label-and-field row for provider connect forms. */
export function CalendarFieldRow({
  label,
  children
}: {
  label: string
  children: ReactNode
}): React.JSX.Element {
  return (
    <div className="flex min-h-9 items-center justify-between gap-4">
      <span className="shrink-0 text-xs/4 text-muted-foreground">{label}</span>
      <div className="flex w-56 max-w-full justify-end">{children}</div>
    </div>
  )
}

export const CALENDAR_FIELD_INPUT = 'h-7 w-full text-xs/4'
