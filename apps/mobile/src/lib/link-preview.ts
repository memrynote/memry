import type { LinkPreview } from '@memry/contracts/webview-bridge'

/**
 * What a page says about itself, for the paste-link menu (#2104).
 *
 * The host fetches because the guest cannot: the WebView document has no
 * network by contract and its CSP grants no remote origin. This is the only
 * outbound request the note screen makes to a third party, and it is made ONLY
 * when the reader has chosen `Bookmark` or `Mention` for a link they pasted —
 * never on note open, and never for a URL they left as plain text. Rendering a
 * favicon or a preview image on the phone is a separate question and a separate
 * issue (#2097); the URLs are carried through so DESKTOP can draw them from the
 * same shared block props.
 *
 * Deliberately a regex reader over the head of the document rather than a
 * parser. Desktop runs metascraper on Node with the DOM libraries that implies,
 * and none of that exists in Hermes; the six strings wanted here all live in
 * `<meta>` and `<title>` tags and are the same six on every site that publishes
 * them at all. A page that publishes none gets an empty answer, which the guest
 * renders as the hostname.
 */

/** A page that takes longer than this to answer is one the reader is not waiting for. */
const FETCH_TIMEOUT_MS = 8_000

/**
 * Only the head is read. Metadata that has not appeared by here is not
 * metadata, and a phone should not hold a 10 MB article in memory to find out.
 */
const MAX_HTML_BYTES = 512 * 1024

/**
 * Chrome's UA. Sites gate metadata on it, and an honest "Memry mobile" gets a
 * consent wall on enough of the web to make the bookmark card useless — the
 * same reason desktop's fetcher sends one.
 */
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

/**
 * Titles that are a bot wall, not a page.
 *
 * Mirrors desktop's `isBotPageTitle` list (`main/inbox/metadata-utils.ts`). Not
 * imported from it: that module is main-process code behind Electron-only
 * neighbours, and one shared list would mean moving it out of the inbox domain
 * for a caller that needs six strings.
 */
const BOT_PAGE_TITLES = [
  'just a moment...',
  'attention required!',
  'access denied',
  'please wait',
  'verify you are human',
  'checking your browser'
]

const EMPTY: LinkPreview = {
  title: '',
  domain: '',
  description: '',
  image: '',
  favicon: '',
  siteName: ''
}

export function linkDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

/** Resolve a possibly-relative asset URL against the page it was found on. */
function absolute(value: string, base: string): string {
  if (!value) return ''
  try {
    const resolved = new URL(value, base)
    // A `data:` favicon would be renderable under the guest CSP, but it also
    // travels into the shared Y.Doc, where an inline blob is a body-size cost
    // every device pays forever. Only http(s) references are kept.
    return resolved.protocol === 'http:' || resolved.protocol === 'https:'
      ? resolved.toString()
      : ''
  } catch {
    return ''
  }
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  '#39': "'"
}

/** Enough entity decoding for a title and a description; not a general decoder. */
function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, body: string) => {
    const named = NAMED_ENTITIES[body.toLowerCase()]
    if (named !== undefined) return named
    if (body.startsWith('#')) {
      const code =
        body[1]?.toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : Number(body.slice(1))
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) return String.fromCodePoint(code)
    }
    return match
  })
}

function clean(value: string | undefined): string {
  if (!value) return ''
  return decodeEntities(value).replace(/\s+/g, ' ').trim()
}

/**
 * Read one `<meta>` content value.
 *
 * Attribute order is not fixed — `content` comes before `property` on plenty of
 * real pages — so the tag is matched whole and its attributes read separately
 * rather than assuming `property="…" content="…"`.
 */
function metaContent(html: string, keys: string[]): string {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const name = /\b(?:property|name|itemprop)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]
    if (!name || !keys.includes(name.toLowerCase())) continue
    const content = /\bcontent\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1]
    const value = clean(content)
    if (value) return value
  }
  return ''
}

function iconHref(html: string): string {
  let fallback = ''
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const rel = /\brel\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]?.toLowerCase()
    if (!rel) continue
    const tokens = rel.split(/\s+/)
    if (!tokens.includes('icon') && !tokens.includes('apple-touch-icon')) continue
    const href = clean(/\bhref\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1])
    if (!href) continue
    // A plain `icon` wins over `apple-touch-icon`, which is a launcher tile and
    // is often a solid-colour square rather than the mark the site uses inline.
    if (tokens.includes('icon')) return href
    if (!fallback) fallback = href
  }
  return fallback
}

/**
 * Pull the six fields out of a page.
 *
 * `finalUrl` is the URL the response came from, not the one that was asked for:
 * relative icon paths resolve against wherever the redirects landed, and a
 * shortener resolved against the shortener serves its own favicon.
 */
export function parseLinkPreview(html: string, finalUrl: string): LinkPreview {
  const head = html.slice(0, MAX_HTML_BYTES)
  const documentTitle = clean(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1])
  const title = metaContent(head, ['og:title', 'twitter:title']) || documentTitle

  return {
    title: isBotPageTitle(title) ? '' : title,
    domain: linkDomain(finalUrl),
    description: metaContent(head, ['og:description', 'twitter:description', 'description']),
    image: absolute(metaContent(head, ['og:image', 'og:image:url', 'twitter:image']), finalUrl),
    favicon: absolute(iconHref(head), finalUrl),
    siteName: metaContent(head, ['og:site_name', 'application-name'])
  }
}

function isBotPageTitle(title: string): boolean {
  const lower = title.toLowerCase()
  return BOT_PAGE_TITLES.some((bot) => lower.includes(bot))
}

/**
 * Fetch and read one URL's metadata.
 *
 * Never rejects. The guest is holding a bookmark card that already shows the
 * hostname, and every failure — offline, a timeout, a 404, a PDF — has the same
 * useful answer: the domain and nothing else.
 */
export async function fetchLinkPreview(url: string): Promise<LinkPreview> {
  const domain = linkDomain(url)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { accept: 'text/html,application/xhtml+xml', 'user-agent': USER_AGENT }
    })
    if (!response.ok) return { ...EMPTY, domain }

    const contentType = response.headers.get('content-type') ?? ''
    // A PDF or an image has no metadata to read and can be arbitrarily large;
    // reading it as text would cost the download for nothing.
    if (contentType && !/text\/html|application\/xhtml/i.test(contentType)) {
      return { ...EMPTY, domain }
    }

    const html = await response.text()
    return parseLinkPreview(html, response.url || url)
  } catch {
    return { ...EMPTY, domain }
  } finally {
    clearTimeout(timeout)
  }
}
