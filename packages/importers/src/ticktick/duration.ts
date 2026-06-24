const PATTERN = /^(-)?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/

/** Parse an ISO-8601 duration (TickTick reminder offset) to signed milliseconds. */
export function parseIsoDurationMs(token: string): number | null {
  const t = token.trim()
  if (!t) return null
  const m = PATTERN.exec(t)
  if (!m) return null
  const [, sign, w, d, h, min, s] = m
  const ms =
    (Number(w ?? 0) * 7 * 24 * 60 * 60 +
      Number(d ?? 0) * 24 * 60 * 60 +
      Number(h ?? 0) * 60 * 60 +
      Number(min ?? 0) * 60 +
      Number(s ?? 0)) *
    1000
  return sign === '-' ? -ms : ms
}
