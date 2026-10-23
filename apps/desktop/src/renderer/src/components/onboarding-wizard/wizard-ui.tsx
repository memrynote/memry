import type { KeyboardEvent, ReactNode } from 'react'
import { useT } from '@memry/i18n/renderer'
import { TrafficLights } from '@/components/traffic-lights'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { Check } from '@/lib/icons'
import { isMac } from '@/lib/shortcut-catalog'
import { cn } from '@/lib/utils'

/** "this Mac" on macOS, "this computer" elsewhere, for copy that names the device. */
export function useDeviceLabel(): string {
  const { t } = useT('common')
  return t(isMac ? 'onboardingWizard.device.mac' : 'onboardingWizard.device.computer')
}

/**
 * Supporting copy. Tertiary ink only clears 4.5:1 on the dark canvas, so the
 * light themes keep the secondary ink.
 */
export const MUTED = 'text-text-secondary dark:text-text-tertiary'

export interface KeyHint {
  keys: string[]
  label: string
  /** Makes the hint a button, for steps whose only way forward or back is the hint. */
  onPress?: () => void
  /** The hint is the step's continue control, so Enter finds it. */
  continues?: boolean
}

function HintKeys({ keys }: { keys: string[] }): React.JSX.Element {
  return (
    <>
      {keys.map((key) => (
        <Kbd
          key={key}
          className="h-5 min-w-5 rounded-[4px] border border-border bg-surface px-[5px] font-mono text-[11px] font-normal text-text-tertiary"
        >
          {key}
        </Kbd>
      ))}
    </>
  )
}

function HintRow({ hints }: { hints: KeyHint[] }): React.JSX.Element {
  return (
    <div className="flex items-center gap-3.5">
      {hints.map((hint) =>
        hint.onPress ? (
          <button
            key={hint.label}
            type="button"
            onClick={hint.onPress}
            data-wizard-continue={hint.continues || undefined}
            className={cn(
              'flex items-center gap-[5px] rounded-sm text-xs transition-colors hover:text-foreground',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              MUTED
            )}
          >
            <HintKeys keys={hint.keys} />
            {hint.label}
          </button>
        ) : (
          <span
            key={hint.label}
            aria-hidden="true"
            className={cn('flex items-center gap-[5px] text-xs', MUTED)}
          >
            <HintKeys keys={hint.keys} />
            {hint.label}
          </span>
        )
      )}
    </div>
  )
}

/**
 * The wizard window. Native window controls own the top-start corner, so the
 * hints sit at the top end, clear of Windows caption buttons too. A step with a
 * stage gets the mini app window under its content: it keeps a fixed visible
 * height while there is room and gives way to the content when there is not.
 */
export function WizardFrame({
  hints,
  headerEnd,
  stage,
  children
}: {
  hints: KeyHint[]
  headerEnd?: ReactNode
  stage?: ReactNode
  children: ReactNode
}): React.JSX.Element {
  return (
    <div className="fixed inset-0 z-50 flex flex-col overflow-hidden bg-background text-foreground antialiased">
      <div className="drag-region flex h-11 shrink-0 items-center ps-4 pe-[calc(1rem+var(--caption-reserve-end,0px))]">
        <TrafficLights compact />
        <div className="ms-auto flex items-center">
          {headerEnd}
          <HintRow hints={hints} />
        </div>
      </div>
      <main className="min-h-0 grow overflow-y-auto">
        <div className="flex h-full flex-col items-center px-6">
          <div className="flex w-full shrink-0 flex-col items-center">{children}</div>
          {stage ? (
            <>
              <div className="flex-[1_0_2.25rem]" />
              <div className="flex min-h-0 w-full flex-[0_1_268px] justify-center overflow-hidden">
                {stage}
              </div>
            </>
          ) : (
            <div className="h-10 shrink-0" />
          )}
        </div>
      </main>
    </div>
  )
}

export function ProgressDots({
  index,
  total
}: {
  index: number
  total: number
}): React.JSX.Element {
  const { t } = useT('common')
  return (
    <div
      className="flex items-center gap-1.5"
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- ARIA widget pattern; native tag would change styling or behavior
      role="progressbar"
      aria-valuemin={1}
      aria-valuemax={total}
      aria-valuenow={index + 1}
      aria-label={t('onboardingWizard.progress', { current: index + 1, total })}
    >
      {Array.from({ length: total }, (_, dot) => (
        <span
          key={dot}
          className={cn(
            'h-1.5 rounded-[3px] transition-[width,background-color] duration-200 motion-reduce:transition-none',
            dot === index ? 'w-[18px] bg-foreground' : 'w-1.5',
            dot < index && 'bg-text-tertiary',
            dot > index && 'bg-border'
          )}
        />
      ))}
    </div>
  )
}

export function StepHeading({ title, body }: { title: string; body?: string }): React.JSX.Element {
  return (
    <div className="flex max-w-[30rem] flex-col items-center gap-2.5 pt-6 text-center">
      <h1 className="font-serif text-[34px] font-medium leading-[38px] tracking-[-0.015em] text-foreground text-balance">
        {title}
      </h1>
      {body && <p className={cn('text-sm leading-[21px] text-balance', MUTED)}>{body}</p>}
    </div>
  )
}

/** Arrow keys move focus between the options inside: up/down, or left/right for a row. */
export function OptionList({
  label,
  role = 'group',
  orientation = 'vertical',
  className,
  children
}: {
  label: string
  role?: 'group' | 'radiogroup'
  orientation?: 'vertical' | 'horizontal'
  className?: string
  children: ReactNode
}): React.JSX.Element {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const rtl = getComputedStyle(event.currentTarget).direction === 'rtl'
    const [prev, next] =
      orientation === 'vertical'
        ? ['ArrowUp', 'ArrowDown']
        : rtl
          ? ['ArrowRight', 'ArrowLeft']
          : ['ArrowLeft', 'ArrowRight']
    if (event.key !== prev && event.key !== next) return
    const options = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>('[data-wizard-option]:not([disabled])')
    )
    const current = options.indexOf(document.activeElement as HTMLElement)
    const target = options[current + (event.key === next ? 1 : -1)]
    if (!target) return
    event.preventDefault()
    target.focus()
  }
  return (
    // oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- pointer handler only stops propagation/handles pointer; keyboard path exists on a child control
    <div
      role={role}
      aria-label={label}
      aria-orientation={role === 'radiogroup' ? orientation : undefined}
      onKeyDown={onKeyDown}
      className={cn('flex', orientation === 'vertical' && 'flex-col', className)}
    >
      {children}
    </div>
  )
}

interface OptionCardProps {
  kind: 'radio' | 'check'
  selected: boolean
  onSelect: () => void
  title: string
  /** Short tag beside the title, like "Most popular". */
  badge?: string
  description?: string
  icon?: ReactNode
  trailing?: ReactNode
  disabled?: boolean
  compact?: boolean
}

/** Selected cards fill with the surface and carry a stronger ring. */
export const SELECTED_RING = 'bg-surface ring-1 ring-inset ring-text-tertiary'

export function OptionCard({
  kind,
  selected,
  onSelect,
  title,
  badge,
  description,
  icon,
  trailing,
  disabled,
  compact
}: OptionCardProps): React.JSX.Element {
  return (
    <button
      type="button"
      data-wizard-option
      role={kind === 'radio' ? 'radio' : 'checkbox'}
      aria-checked={selected}
      disabled={disabled}
      onClick={onSelect}
      // A radio follows focus, so arrowing through the list picks as it goes.
      onFocus={kind === 'radio' && !selected ? onSelect : undefined}
      className={cn(
        'group flex w-full items-start gap-3.5 rounded-lg text-start transition-colors duration-150 motion-reduce:transition-none',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        'disabled:cursor-not-allowed disabled:opacity-60',
        compact ? 'px-3 py-2.5' : 'px-[18px] py-4',
        selected ? SELECTED_RING : 'ring-1 ring-inset ring-border hover:bg-surface/60'
      )}
    >
      <span className="pt-0.5">
        {kind === 'radio' ? <RadioMark on={selected} /> : <CheckMark on={selected} />}
      </span>
      <span className="flex min-w-0 grow basis-0 flex-col gap-1">
        <span className="flex items-center justify-between gap-3">
          <span className="flex min-w-0 items-center gap-2">
            {icon && <span className="shrink-0 text-foreground [&_svg]:size-[15px]">{icon}</span>}
            <span className="truncate text-[14.5px] font-semibold leading-[18px] text-foreground">
              {title}
            </span>
            {badge && (
              <span className="shrink-0 rounded-full bg-tint/15 px-2 py-0.5 text-[11px] font-semibold leading-[14px] text-tint">
                {badge}
              </span>
            )}
          </span>
          {trailing && (
            <span className={cn('shrink-0 text-[12.5px] font-medium', MUTED)}>{trailing}</span>
          )}
        </span>
        {description && (
          <span className={cn('text-[13px] leading-[19px]', MUTED)}>{description}</span>
        )}
      </span>
    </button>
  )
}

export function RadioMark({ on }: { on: boolean }): React.JSX.Element {
  return (
    <span
      className={cn(
        'flex size-4 shrink-0 items-center justify-center rounded-full border-[1.5px]',
        on ? 'border-foreground' : 'border-text-tertiary'
      )}
    >
      {on && <span className="size-2 rounded-full bg-foreground" />}
    </span>
  )
}

export function CheckMark({ on }: { on: boolean }): React.JSX.Element {
  return (
    <span
      className={cn(
        'flex size-4 shrink-0 items-center justify-center rounded-[4px] border-[1.5px]',
        on ? 'border-foreground bg-foreground text-background' : 'border-text-tertiary'
      )}
    >
      {on && <Check className="size-3" />}
    </span>
  )
}

/** The look of `Switch`, for a row that is itself the checkbox control. */
export function SwitchMark({ on }: { on: boolean }): React.JSX.Element {
  return (
    <span
      className={cn(
        'flex h-5 w-9 shrink-0 items-center rounded-full border-2 border-transparent transition-colors motion-reduce:transition-none',
        on ? 'justify-end bg-[var(--tint)]' : 'justify-start bg-input'
      )}
    >
      <span className="size-4 rounded-full bg-background shadow-sm" />
    </span>
  )
}

/** The default accent, not the user's: the welcome screen runs before any theme is picked. */
export const BRAND_COLOR = 'text-[var(--default-user-accent-color)]'
const BRAND_BUTTON =
  'bg-[var(--default-user-accent-color)] text-white hover:bg-[color-mix(in_srgb,var(--default-user-accent-color)_88%,black)]'

export function ContinueButton({
  label,
  onClick,
  disabled,
  loading,
  brand
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  loading?: boolean
  /** Memry orange, for the welcome screen's first call to action. */
  brand?: boolean
}): React.JSX.Element {
  return (
    <Button
      data-wizard-continue
      onClick={onClick}
      disabled={disabled || loading}
      aria-busy={loading}
      className={cn(
        'h-[38px] shrink-0 gap-2.5 pe-2.5 ps-4 text-sm font-semibold shadow-none',
        brand && BRAND_BUTTON
      )}
    >
      {label}
      <Kbd className="h-5 rounded-[4px] bg-black/10 px-1.5 font-mono text-[11px] font-medium text-current">
        ↵
      </Kbd>
    </Button>
  )
}

export function QuietLink({
  children,
  onClick,
  underline = true
}: {
  children: ReactNode
  onClick: () => void
  underline?: boolean
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-sm text-[13px] transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        underline && 'font-medium underline decoration-border underline-offset-[3px]',
        MUTED
      )}
    >
      {children}
    </button>
  )
}

export function SectionLabel({
  children,
  className
}: {
  children: ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <span
      className={cn(
        'pb-1.5 text-[10.5px] font-semibold uppercase leading-[14px] tracking-[0.07em]',
        MUTED,
        className
      )}
    >
      {children}
    </span>
  )
}
