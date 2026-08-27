/**
 * `linkMention` inline content spec. Portable in full — vanilla DOM, no
 * renderer imports — so both processes use it unchanged. See wiki-link.ts for
 * why main needs the spec at all.
 */

import { createInlineContentSpec, type InlineContentSpec } from '@blocknote/core'

/**
 * Markdown persistence token for link mentions. A mention is serialized to
 * literal text `((mention:<encodeURIComponent(url)>))` so it survives the
 * markdown round-trip as a single text node (a raw URL would be GFM
 * auto-linkified and fragmented; an <a> would be claimed by BlockNote's
 * built-in link mark). Reconstructed on load by normalizeLinkMentions.
 *
 * The pattern is deliberately wider than the alphabet the serializer emits. A
 * token written by an older build can hold a stray space or a remark escape
 * (see `parseLinkMentionToken`), and the previous `[^)\s]+` refused both — the
 * token then never matched and stayed literal `((mention:…))` text for good.
 * Every payload that pattern accepted, this one accepts identically.
 */
export const MENTION_TOKEN_REGEX = /\(\(mention:([^)\n\r]+)\)\)/g

/**
 * `encodeURIComponent` leaves `- _ . ! ~ * ' ( )` raw. `(` and `)` break the
 * `))` delimiter. The rest are markdown-significant, and remark-stringify does
 * NOT escape them inside the token — so two mentions on one line whose URLs
 * both hold a `*` (or both a `~`) come back as one emphasis run spanning from
 * the first token into the second, and both mentions are destroyed (#1844).
 *
 * Encoding all seven closes the alphabet to `[A-Za-z0-9.%-]`, so the property
 * is structural rather than a bet on remark's flanking rules staying put.
 * `.` and `-` stay raw: both are inert unless they open a line, and a token
 * never does.
 */
const TOKEN_UNSAFE = /[!'()*~_]/g
const TOKEN_UNSAFE_ENCODED: Record<string, string> = {
  '!': '%21',
  "'": '%27',
  '(': '%28',
  ')': '%29',
  '*': '%2A',
  '~': '%7E',
  _: '%5F'
}

export function serializeLinkMentionToken(url: string): string {
  const encoded = encodeURIComponent(url).replace(
    TOKEN_UNSAFE,
    (char) => TOKEN_UNSAFE_ENCODED[char]
  )
  return `((mention:${encoded}))`
}

/**
 * Any payload with no whitespace and no backslash: everything this serializer
 * emits, and every older token that reached disk intact. Those keep the
 * original code path so their bytes and their failure modes are unchanged.
 */
const WELL_FORMED_PAYLOAD = /^[^\s\\]+$/

function isAbsoluteUrl(value: string): boolean {
  try {
    new URL(value)
    return true
  } catch {
    return false
  }
}

export function parseLinkMentionToken(encoded: string): string | null {
  if (WELL_FORMED_PAYLOAD.test(encoded)) {
    try {
      return decodeURIComponent(encoded) || null
    } catch {
      return null
    }
  }

  // Vaults hold tokens from builds that left `_ * ! ~ '` raw, so remark's
  // escapes and stray whitespace are already on disk. Neither a backslash nor
  // whitespace is legal in the token alphabet, so stripping them is an
  // unambiguous repair rather than a guess; requiring a parseable URL after the
  // repair stops the widened pattern from claiming ordinary prose.
  const repaired = encoded.replace(/[\s\\]/g, '')
  if (!repaired) return null
  try {
    const url = decodeURIComponent(repaired)
    return isAbsoluteUrl(url) ? url : null
  } catch {
    return null
  }
}

export function createLinkMentionContent(
  url: string,
  domain: string,
  title?: string,
  favicon?: string,
  siteName?: string
) {
  return {
    type: 'linkMention' as const,
    props: { url, domain, title: title ?? '', favicon: favicon ?? '', siteName: siteName ?? '' }
  }
}

export const linkMentionConfig = {
  type: 'linkMention' as const,
  propSchema: {
    url: { default: '' },
    domain: { default: '' },
    title: { default: '' },
    favicon: { default: '' },
    siteName: { default: '' }
  },
  content: 'none' as const
}

/** Matches only the editor's own markup — no text heuristic, so it is safe on both sides. */
const linkMentionParse = (element: HTMLElement) => {
  if (element.hasAttribute('data-link-mention')) {
    const url = element.getAttribute('data-url') || ''
    const domain = element.getAttribute('data-domain') || ''
    const title = element.getAttribute('data-title') || ''
    const favicon = element.getAttribute('data-favicon') || ''
    const siteName = element.getAttribute('data-site-name') || ''
    if (!url) return undefined
    return { url, domain, title, favicon, siteName }
  }

  return undefined
}

/**
 * The node's on-disk form. Emits the markdown persistence token as plain text
 * (not an `<a>`, which BlockNote's link mark would reclaim on reload);
 * normalizeLinkMentions rebuilds the rich inline content from it on load.
 */
const linkMentionToExternalHTML = (inlineContent: {
  props: { url: string }
}): { dom: HTMLElement } => {
  const dom = document.createElement('span')
  dom.textContent = serializeLinkMentionToken(inlineContent.props.url)
  return { dom }
}

export const LinkMention = createInlineContentSpec(linkMentionConfig, {
  render: (inlineContent) => {
    const { url, domain, title, favicon, siteName } = inlineContent.props
    const siteLabel = siteName || domain || url

    const dom = document.createElement('a')
    dom.className = 'link-mention'
    dom.href = url
    dom.target = '_blank'
    dom.rel = 'noopener noreferrer'
    dom.setAttribute('data-link-mention', '')
    dom.setAttribute('data-url', url)
    dom.setAttribute('data-domain', domain)
    dom.setAttribute('data-title', title)
    dom.setAttribute('data-favicon', favicon)
    dom.setAttribute('data-site-name', siteName)
    dom.setAttribute('contenteditable', 'false')

    if (favicon) {
      const img = document.createElement('img')
      img.className = 'link-mention-favicon'
      img.src = favicon
      img.alt = ''
      img.onerror = () => {
        img.style.display = 'none'
      }
      dom.appendChild(img)
    }

    const siteSpan = document.createElement('span')
    siteSpan.className = 'link-mention-site'
    siteSpan.textContent = siteLabel
    dom.appendChild(siteSpan)

    if (title) {
      const titleSpan = document.createElement('span')
      titleSpan.className = 'link-mention-title'
      titleSpan.textContent = title
      dom.appendChild(titleSpan)
    }

    return { dom }
  },

  parse: linkMentionParse,

  toExternalHTML: linkMentionToExternalHTML
})

/**
 * The same node for the main process — same type, same props, same on-disk
 * form — but rendering the token instead of the rich `<a>` chip.
 *
 * `render` is not dead weight on the server: BlockNote serializes inline
 * content inside a TABLE through `render`, not `toExternalHTML`. With the
 * editor's implementation registered, a mention in a table cell came out as
 * `| [x.com](https://x.com/y) |` — the token, domain, title, favicon and
 * siteName gone from disk for good. A server render must therefore emit
 * exactly what `toExternalHTML` emits; it must never be rich, and it must
 * never throw.
 */
export const LinkMentionSerializationOnly: InlineContentSpec<typeof linkMentionConfig> =
  createInlineContentSpec(linkMentionConfig, {
    render: linkMentionToExternalHTML,
    parse: linkMentionParse,
    toExternalHTML: linkMentionToExternalHTML
  })
