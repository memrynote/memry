import { cn } from '@/lib/utils'
import { formatRelativeDateHint } from '@/lib/task-utils'

/**
 * A date row in the task detail drawer: label, the interactive date badge, and —
 * underneath it — how far away that date is. The badge only ever renders an
 * absolute date ("Mar 15"), which says nothing about whether that is tomorrow or
 * next month; the drawer is 240-480px wide, so the hint cannot sit inline beside
 * the badge without clipping at the narrow end (#1861).
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
    <div className="flex items-start py-1.5">
      {/* `leading-6` matches the badge's 24px box, so the label still lines up
          with it once the hint adds a second line. */}
      <span className="text-[12px] w-[90px] shrink-0 text-text-tertiary leading-6">{label}</span>
      <div className="flex flex-col items-start min-w-0">
        {children}
        {hint && (
          // `ps-2` matches the badge's own horizontal padding, so the hint
          // starts under the badge's text rather than under its border.
          <span
            className={cn(
              'text-[11px] leading-4 ps-2',
              hint.tone === 'overdue' ? 'text-task-due-overdue' : 'text-text-tertiary'
            )}
          >
            {hint.label}
          </span>
        )}
      </div>
    </div>
  )
}
