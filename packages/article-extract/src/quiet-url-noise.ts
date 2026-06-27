/**
 * Defuddle resolves relative canonical / og:url / in-content links with
 * `new URL(href)` (no base argument). On pages full of relative links — forums,
 * wikis, etc. — every one throws, and defuddle catches it but logs a full
 * `Failed to parse URL` stack via `console.error` / `console.warn`. The errors
 * are harmless (extraction still completes) but spam the log, especially when a
 * bulk import extracts hundreds of pages at once.
 *
 * Run defuddle inside this wrapper to swallow just those lines. Everything else
 * still logs. The desktop inbox job processor is single-threaded, so temporarily
 * swapping `console` here can't race other work.
 */
const URL_PARSE_NOISE = 'Failed to parse URL'

function isUrlParseNoise(args: unknown[]): boolean {
  return typeof args[0] === 'string' && args[0].includes(URL_PARSE_NOISE)
}

export async function quietDefuddleUrlNoise<T>(run: () => Promise<T>): Promise<T> {
  const origError = console.error
  const origWarn = console.warn
  const filter =
    (orig: (...args: unknown[]) => void) =>
    (...args: unknown[]): void => {
      if (isUrlParseNoise(args)) return
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
