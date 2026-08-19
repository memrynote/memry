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
 */
export const MENTION_TOKEN_REGEX = /\(\(mention:([^)\s]+)\)\)/g

export function serializeLinkMentionToken(url: string): string {
  // encodeURIComponent leaves `(` and `)` raw, which would break the `))`
  // delimiter for URLs containing parens — escape them explicitly.
  const encoded = encodeURIComponent(url).replace(/\(/g, '%28').replace(/\)/g, '%29')
  return `((mention:${encoded}))`
}

export function parseLinkMentionToken(encoded: string): string | null {
  try {
    const url = decodeURIComponent(encoded)
    return url || null
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
