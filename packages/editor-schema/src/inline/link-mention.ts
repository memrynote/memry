/**
 * `linkMention` inline content spec. Portable in full — vanilla DOM, no
 * renderer imports — so both processes use it unchanged. See wiki-link.ts for
 * why main needs the spec at all.
 */

import { createInlineContentSpec } from '@blocknote/core'

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

  parse: (element) => {
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
  },

  toExternalHTML: (inlineContent) => {
    // Emit the markdown persistence token as plain text (not an <a>, which
    // BlockNote's link mark would reclaim on reload). normalizeLinkMentions
    // rebuilds the rich inline content from this token on load.
    const dom = document.createElement('span')
    dom.textContent = serializeLinkMentionToken(inlineContent.props.url)
    return { dom }
  }
})
