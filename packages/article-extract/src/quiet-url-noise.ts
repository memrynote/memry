/**
 * Defuddle logs its own caught-but-noisy errors via `console.error` /
 * `console.warn`, and a bulk import extracting hundreds of pages turns that into
 * a wall of red. Two shapes, both harmless (extraction still completes):
 *   - `console.error('Defuddle', 'Error in async extraction:', err)` — e.g. a
 *     dead/blocked link it tried to fetch (Reddit 403, etc.).
 *   - `console.error('Failed to parse URL: ...', err)` / `console.warn(...)` —
 *     relative canonical/og:url/in-content links resolved with `new URL()` and no
 *     base, which throw on forum/wiki pages full of relative links.
 *
 * Run defuddle inside this wrapper to swallow just defuddle's own lines.
 * Everything else still logs. The desktop inbox job processor is single-threaded,
 * so temporarily swapping `console` here can't race other work.
 */
const URL_PARSE_NOISE = 'Failed to parse URL'

function isDefuddleNoise(args: unknown[]): boolean {
  const first = args[0]
  return typeof first === 'string' && (first === 'Defuddle' || first.includes(URL_PARSE_NOISE))
}

export async function quietDefuddleUrlNoise<T>(run: () => Promise<T>): Promise<T> {
  const origError = console.error
  const origWarn = console.warn
  const filter =
    (orig: (...args: unknown[]) => void) =>
    (...args: unknown[]): void => {
      if (isDefuddleNoise(args)) return
      orig(...args)
    }
  console.error = filter(origError)
  console.warn = filter(origWarn)
  try {
    return await run()
  } finally {
    console.error = origError
    console.warn = origWarn
  }
}
