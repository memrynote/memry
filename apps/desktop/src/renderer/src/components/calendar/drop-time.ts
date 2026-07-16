const SNAP_MINUTES = 15
const MINUTES_IN_DAY = 1440
const LAST_SLOT_MINUTES = MINUTES_IN_DAY - SNAP_MINUTES

/**
 * Convert a pixel offset from the top of a day column into a wall-clock time,
 * snapped to 15 minutes and clamped inside the day.
 */
export function timeFromOffset(offsetY: number, hourHeight: number): string {
  const rawMinutes = (offsetY / hourHeight) * 60
  const snapped = Math.round(rawMinutes / SNAP_MINUTES) * SNAP_MINUTES
  const clamped = Math.max(0, Math.min(snapped, LAST_SLOT_MINUTES))
  const hours = Math.floor(clamped / 60)
  const minutes = clamped % 60
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
}
