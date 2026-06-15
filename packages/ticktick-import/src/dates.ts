export interface DatePieces {
  date: string | null
  time: string | null
}

function format(instant: Date, timeZone: string): Record<string, string> {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  })
  return Object.fromEntries(fmt.formatToParts(instant).map((p) => [p.type, p.value]))
}

/** Convert a tz-aware ISO instant to { date 'YYYY-MM-DD', time 'HH:mm' } in `timezone`. */
export function splitDateTime(iso: string, timezone: string, allDay: boolean): DatePieces {
  if (!iso.trim()) return { date: null, time: null }
  const instant = new Date(iso)
  if (Number.isNaN(instant.getTime())) return { date: null, time: null }
  const tz = timezone.trim() || 'UTC'
  let parts: Record<string, string>
  try {
    parts = format(instant, tz)
  } catch {
    parts = format(instant, 'UTC')
  }
  const date = `${parts.year}-${parts.month}-${parts.day}`
  return { date, time: allDay ? null : `${parts.hour}:${parts.minute}` }
}
