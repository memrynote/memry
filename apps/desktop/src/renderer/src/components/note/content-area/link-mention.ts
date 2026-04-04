import { createInlineContentSpec } from '@blocknote/core'

export function createLinkMentionContent(
  url: string,
  domain: string,
  title?: string,
  favicon?: string
) {
  return {
    type: 'linkMention' as const,
    props: { url, domain, title: title ?? '', favicon: favicon ?? '' }
  }
}

export const LinkMention = createInlineContentSpec(
  {
    type: 'linkMention',
    propSchema: {
      url: { default: '' },
      domain: { default: '' },
      title: { default: '' },
      favicon: { default: '' }
    },
    content: 'none'
  },
  {
    render: (inlineContent) => {
      const { url, domain, title, favicon } = inlineContent.props

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
      dom.setAttribute('contenteditable', 'false')

      if (favicon) {
        const img = document.createElement('img')
        img.className = 'link-mention-favicon'
        img.src = favicon
        img.width = 14
        img.height = 14
        img.alt = ''
        img.onerror = () => {
          img.style.display = 'none'
        }
        dom.appendChild(img)
      }

      const domainSpan = document.createElement('span')
      domainSpan.textContent = domain || url
      dom.appendChild(domainSpan)

      if (title) {
        const sep = document.createElement('span')
        sep.className = 'link-mention-sep'
        sep.textContent = ' \u00B7 '
        dom.appendChild(sep)

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
        if (!url) return undefined
        return { url, domain, title, favicon }
      }

      if (element.tagName === 'A' && element.getAttribute('title') === 'mention') {
        const url = (element as HTMLAnchorElement).href || ''
        const text = element.textContent || ''
        const parts = text.split(' \u00B7 ')
        return { url, domain: parts[0] || '', title: parts[1] || '', favicon: '' }
      }

      return undefined
    },

    toExternalHTML: (inlineContent) => {
      const { url, domain, title } = inlineContent.props
      const text = title ? `${domain} \u00B7 ${title}` : domain || url

      const dom = document.createElement('a')
      dom.href = url
      dom.title = 'mention'
      dom.textContent = text
      return { dom }
    }
  }
)
