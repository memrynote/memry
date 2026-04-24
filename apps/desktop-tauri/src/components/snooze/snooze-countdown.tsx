/**
 * Snooze Countdown Component
 *
 * Displays a live countdown badge showing remaining snooze time.
 * Updates every minute automatically.
 *
 * @module components/snooze/snooze-countdown
 */

import { Clock } from '@/lib/icons'
import { useSnoozeCountdown } from './use-snooze-countdown'

// ============================================================================
// Component Props
// ============================================================================

export interface SnoozeCountdownProps {
  /** The date/time when snooze expires */
  snoozedUntil: Date | string | null | undefined
  /** Optional additional class names */
  className?: string
}

// ============================================================================
// Component
// ============================================================================

/**
 * A badge component that displays a live countdown for snoozed items.
 * Automatically updates every minute.
 *
 * @example
 * <SnoozeCountdown snoozedUntil={item.snoozedUntil} />
 */
export function SnoozeCountdown({
  snoozedUntil,
  className
}: SnoozeCountdownProps): React.JSX.Element | null {
  const countdown = useSnoozeCountdown(snoozedUntil ?? null)

  if (!countdown) {
    return null
  }

  return (
    <span
      className={
        className ||
        'inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400'
      }
    >
      <Clock className="w-2.5 h-2.5" aria-hidden="true" />
      {countdown}
    </span>
  )
}

export default SnoozeCountdown
