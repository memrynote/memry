import { shellGlobals } from './shell-globals'

/**
 * Builds a memry-file:// URL from an absolute local file path.
 *
 * The main-process protocol handler expects `memry-file://local/<path>`: it
 * decodes `url.pathname` with `decodeURIComponent` and, on Windows, strips the
 * leading slash so `/C:/Users/...` resolves back to `C:/Users/...`. Backslashes
 * are normalized to forward slashes, the leading slash is guaranteed (Windows
 * drive paths have none), and each segment is percent-encoded so spaces and
 * non-ASCII filenames survive the handler's decode.
 */
export function toMemryFileUrl(absolutePath: string): string {
  const normalized = absolutePath.replace(/\\/g, '/')
  const withLeadingSlash = normalized.startsWith('/') ? normalized : `/${normalized}`
  const encoded = withLeadingSlash
    .split('/')
    .map((segment) => encodeURIComponent(segment).replace(/%3A/gi, ':'))
    .join('/')
  return `memry-file://local${encoded}`
}

const LOCAL_URL = /^(memry-file|memry-html):\/\/local(\/.*)?$/

/**
 * The URL a webview element can load. Stored URLs stay canonical (`memry-file://local/...`); on
 * Windows WebView2 serves a custom scheme from `https://<scheme>.localhost`, so the canonical
 * form is rewritten there and left alone everywhere else. Comparisons such as
 * `startsWith('memry-file:')` keep the canonical form: apply this at the element, not before.
 */
export function toWebviewUrl(
  url: string,
  platform: string = document.documentElement.getAttribute('data-platform') ?? ''
): string {
  if (platform !== 'win32') return url
  const match = LOCAL_URL.exec(url)
  if (!match) return url
  return `https://${match[1]}.localhost/local${match[2] ?? ''}`
}

/** URL-safe base64 without padding, of the UTF-8 bytes of `text` (what the loopback route reads). */
function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

/**
 * The loopback server URL of a canonical `memry-file://` URL, for `<audio>` and `<video>`: the
 * scheme buffers a response in memory, the server streams it. A URL that is not a `memry-file`
 * one, or a page with no server, gets the webview URL.
 */
export function toMediaUrl(url: string): string {
  const shell = shellGlobals()
  if (!shell?.loopbackOrigin || !url.startsWith('memry-file://local/')) return toWebviewUrl(url)
  return `${shell.loopbackOrigin}/m/${shell.loopbackToken}/${toBase64Url(url)}`
}

/** The loopback page that frames a YouTube video with a referrer YouTube accepts. */
export function toYoutubeEmbedUrl(videoId: string): string {
  const shell = shellGlobals()
  if (!shell?.loopbackOrigin) {
    return `https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1&rel=0`
  }
  return `${shell.loopbackOrigin}/e/${shell.loopbackToken}/youtube/${videoId}`
}
