const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['day', 86_400],
  ['hour', 3_600],
  ['minute', 60]
]

/** "5 minutes ago" in the app language. Under a minute reads as "now". */
export function formatRelativePast(iso: string, language: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000))
  const formatter = new Intl.RelativeTimeFormat(language, { numeric: 'auto' })
  for (const [unit, size] of UNITS) {
    if (seconds >= size) return formatter.format(-Math.floor(seconds / size), unit)
  }
  return formatter.format(0, 'second')
}
