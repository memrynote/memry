/**
 * YouTube refuses to configure its player for an embedder it cannot identify.
 *
 * The packaged renderer is loaded with `loadFile()`, so a note's document
 * origin is `file://`, and Chromium sends no `Referer` at all from a file://
 * document to an https subframe. The embed HTML then comes back carrying
 * `ERROR_CODE_EMBEDDER_IDENTITY_MISSING_REFERRER`, which the player renders as
 * "Error 153 — Video player configuration error".
 *
 * Dev never reproduces this: `ELECTRON_RENDERER_URL` gives the document a real
 * `http://localhost` origin, so Chromium sends a Referer on its own and the
 * embed plays. The bug is only reachable in a packaged build.
 *
 * Until the renderer is served from a real app origin, name the app's own site
 * as the embedder on the one request that would otherwise arrive bare.
 */

/** Embed origins that require an identifiable embedder. */
const IDENTIFIED_EMBED_ORIGINS = new Set(['https://www.youtube-nocookie.com'])

/** The app's own site: what the embed is embedded *by*. */
export const EMBED_REFERER = 'https://memrynote.com/'

/**
 * Returns the request headers to send instead of `requestHeaders`, or `null`
 * to leave the request untouched.
 */
export function decideEmbedRequestHeaders(
  url: string,
  requestHeaders: Record<string, string>
): Record<string, string> | null {
  let origin: string
  try {
    origin = new URL(url).origin
  } catch {
    return null
  }

  if (!IDENTIFIED_EMBED_ORIGINS.has(origin)) return null

  // Anything that already carries a referrer keeps it: the dev document's
  // http://localhost origin, and every request the player itself makes from
  // inside the loaded frame. Only the file:// frame load arrives bare.
  if (Object.keys(requestHeaders).some((name) => name.toLowerCase() === 'referer')) return null

  return { ...requestHeaders, Referer: EMBED_REFERER }
}
