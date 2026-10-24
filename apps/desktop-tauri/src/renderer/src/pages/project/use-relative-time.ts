import { useNowMinute } from '@/hooks/use-now-minute'

/**
 * Pure formatter — `now` is passed in, so this is testable and render-safe.
 *
 * Floors at every step, matching `note-card-pieces.tsx`: rounding would label a
 * 1h31m-old note "2h" here and "1h" on a folder card for the same timestamp.
 */
export function formatRelative(then: Date, language: string, now: number): string {
  const minutes = Math.floor((now - then.getTime()) / 60_000)
  if (minutes < 60) return `${Math.max(minutes, 1)}m`
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)}h`
  if (minutes < 60 * 24 * 7) return `${Math.floor(minutes / (60 * 24))}d`
  return new Intl.DateTimeFormat(language, { month: 'short', day: 'numeric' }).format(then)
}

/** Compact relative label — "2h", "3d", else a short date. Refreshes each minute. */
export function useRelativeTime(iso: string | null, language: string): string | null {
  const now = useNowMinute()
  return iso ? formatRelative(new Date(iso), language, now) : null
}
