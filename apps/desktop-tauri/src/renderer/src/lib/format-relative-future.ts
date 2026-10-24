const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['day', 86_400],
  ['hour', 3_600],
  ['minute', 60]
]

/** "in 5 minutes" in the app language. Under a minute reads as "now". */
export function formatRelativeFuture(iso: string, language: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((new Date(iso).getTime() - now) / 1000))
  const formatter = new Intl.RelativeTimeFormat(language, { numeric: 'auto' })
  for (const [unit, size] of UNITS) {
    if (seconds >= size) return formatter.format(Math.round(seconds / size), unit)
  }
  return formatter.format(0, 'second')
}
