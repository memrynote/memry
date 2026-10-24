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
