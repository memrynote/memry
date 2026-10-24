import { cn } from '@/lib/utils'
import { formatRelativeDateHint } from '@/lib/task-utils'

// The drawer's property rows have no label column: each trigger's own leading
// icon identifies the property, and the row's name lives in its tooltip and the
// trigger's aria-label. Every trigger comes from a different component with its
// own pill chrome (tinted background, border, 11-12px text), so the drawer
// strips it back to plain text on a full-width 28px row. `bg-transparent!` has
// to be important: status/priority/project set their tint as an inline style.
// `px-2` puts every icon on the same 8px lane; `[&>svg]:size-3.5` evens out the
// icon sizes so the text after them lines up too.
export const PROPERTY_ROW_TRIGGER =
  'h-7 w-full min-w-0 justify-start gap-2.5 rounded-md border-0 bg-transparent! py-0 px-2 text-[13px] font-medium leading-[18px] hover:opacity-100 [&>svg]:size-3.5 [&>svg]:shrink-0'
// Status, priority and project colour their label text with an inline style.
// Without the pill tint behind it a user-picked colour (e.g. a pale yellow
// project) can fail contrast, so the colour stays on the icon only.
export const PROPERTY_ROW_TRIGGER_NEUTRAL_TEXT = `${PROPERTY_ROW_TRIGGER} [&>div:last-child]:text-text-primary!`
// The project swatch is an 8px div, not an svg; 3px margins centre it on the
// 14px icon lane.
export const PROPERTY_ROW_TRIGGER_PROJECT = `${PROPERTY_ROW_TRIGGER_NEUTRAL_TEXT} [&>div:first-child]:mx-[3px]`

/**
 * A row in the task detail drawer's property list: the interactive trigger,
 * plus an optional trailing hint. Hover and focus tint the whole row so the
 * plain-text trigger still reads as clickable.
 */
export const PropertyRow = ({
  label,
  trailing,
  children
}: {
  label: string
  trailing?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element => (
  <div
    title={label}
    className="flex items-center rounded-md transition-colors duration-150 hover:bg-surface-active/60 focus-within:bg-surface-active/60"
  >
    {/* Basis `auto` + a much higher shrink factor on the hint: at the drawer's
        240px minimum the hint truncates before the date does. */}
    <div className="flex min-w-0 grow basis-auto">{children}</div>
    {trailing}
  </div>
)

/**
 * A date row: the interactive date trigger and, at the row's end, how far away
 * that date is. The trigger only renders an absolute date ("Mar 15"), which says
 * nothing about whether that is tomorrow or next month (#1861).
 */
export const DatePropertyRow = ({
  label,
  date,
  kind,
  isCompleted,
  children
}: {
  label: string
  date: Date | null
  kind: 'due' | 'start'
  isCompleted: boolean
  children: React.ReactNode
}): React.JSX.Element => {
  const hint = formatRelativeDateHint(date, { kind, isCompleted })

  return (
    <PropertyRow
      label={label}
      trailing={
        hint && (
          <span
            className={cn(
              'min-w-0 shrink-[10] truncate pe-2 ps-2 text-[12px] leading-4',
              hint.tone === 'overdue' ? 'text-task-due-overdue' : 'text-text-tertiary'
            )}
          >
            {hint.label}
          </span>
        )
      }
    >
      {children}
    </PropertyRow>
  )
}
