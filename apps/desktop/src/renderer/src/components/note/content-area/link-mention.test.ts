import { describe, expect, it } from 'vitest'

import {
  createLinkMentionContent,
  LinkMention,
  serializeLinkMentionToken,
  parseLinkMentionToken
} from './link-mention'

describe('LinkMention inline content', () => {
  it('creates link mention payloads with optional title, favicon, and site name defaults', () => {
    expect(createLinkMentionContent('https://memry.test/page', 'memry.test')).toEqual({
      type: 'linkMention',
      props: {
        url: 'https://memry.test/page',
        domain: 'memry.test',
        title: '',
        favicon: '',
        siteName: ''
      }
    })

    expect(
      createLinkMentionContent(
        'https://memry.test/page',
        'memry.test',
        'memrynote',
        'https://memry.test/favicon.ico',
        'Memry Notes'
      )
    ).toEqual({
      type: 'linkMention',
      props: {
        url: 'https://memry.test/page',
        domain: 'memry.test',
        title: 'memrynote',
        favicon: 'https://memry.test/favicon.ico',
        siteName: 'Memry Notes'
      }
    })
  })

  it('renders favicon, site name, title, data attributes, fallback text, and image error hiding', () => {
    const render = (LinkMention as any).implementation.render({
      props: {
        url: 'https://memry.test/page',
        domain: 'memry.test',
        title: 'memrynote Page',
        favicon: 'https://memry.test/favicon.ico',
        siteName: 'Memry Notes'
      }
    })

    expect(render.dom).toHaveAttribute('href', 'https://memry.test/page')
    expect(render.dom).toHaveAttribute('target', '_blank')
    expect(render.dom).toHaveAttribute('rel', 'noopener noreferrer')
    expect(render.dom).toHaveAttribute('data-link-mention', '')
    expect(render.dom).toHaveAttribute('data-title', 'memrynote Page')
    expect(render.dom).toHaveAttribute('data-site-name', 'Memry Notes')
    expect(render.dom.querySelector('.link-mention-site')?.textContent).toBe('Memry Notes')
    expect(render.dom.querySelector('.link-mention-title')?.textContent).toBe('memrynote Page')

    const image = render.dom.querySelector('img') as HTMLImageElement
    expect(image).toHaveAttribute('src', 'https://memry.test/favicon.ico')
    image.onerror?.(new Event('error'))
    expect(image).toHaveStyle({ display: 'none' })

    const domainFallback = (LinkMention as any).implementation.render({
      props: {
        url: 'https://memry.test/page',
        domain: 'memry.test',
        title: '',
        favicon: '',
        siteName: ''
      }
    })
    expect(domainFallback.dom.querySelector('.link-mention-site')?.textContent).toBe('memry.test')

    const fallback = (LinkMention as any).implementation.render({
      props: {
        url: 'https://fallback.test/page',
        domain: '',
        title: '',
        favicon: '',
        siteName: ''
      }
    })
    expect(fallback.dom.textContent).toBe('https://fallback.test/page')
    expect(fallback.dom.querySelector('img')).toBeNull()
  })

  it('parses data-link mentions and rejects unknown or empty links', () => {
    const dataElement = document.createElement('a')
    dataElement.setAttribute('data-link-mention', '')
    dataElement.setAttribute('data-url', 'https://memry.test/page')
    dataElement.setAttribute('data-domain', 'memry.test')
    dataElement.setAttribute('data-title', 'memrynote Page')
    dataElement.setAttribute('data-favicon', 'https://memry.test/favicon.ico')
    expect((LinkMention as any).implementation.parse(dataElement)).toEqual({
      url: 'https://memry.test/page',
      domain: 'memry.test',
      title: 'memrynote Page',
      favicon: 'https://memry.test/favicon.ico',
      siteName: ''
    })

    dataElement.setAttribute('data-site-name', 'Memry Notes')
    expect((LinkMention as any).implementation.parse(dataElement)).toEqual(
      expect.objectContaining({ siteName: 'Memry Notes' })
    )
    dataElement.removeAttribute('data-site-name')

    dataElement.setAttribute('data-url', '')
    expect((LinkMention as any).implementation.parse(dataElement)).toBeUndefined()

    expect(
      (LinkMention as any).implementation.parse(document.createElement('span'))
    ).toBeUndefined()
  })

  it('serializes to external HTML as a persistence token that round-trips', () => {
    const url = 'https://eksisozluk.com/entry/184233570?debe=true'
    const result = (LinkMention as any).implementation.toExternalHTML({
      props: { url, domain: 'eksisozluk.com', title: 'duolingo', siteName: 'ekşi sözlük' }
    })
    expect(result.dom.tagName).toBe('SPAN')
    expect(result.dom.textContent).toBe(serializeLinkMentionToken(url))
    // No bare URL/anchor that GFM would auto-link or BlockNote would reclaim.
    expect(result.dom.querySelector('a')).toBeNull()
    expect(result.dom.textContent).not.toContain(url)
  })

  it('round-trips the mention token including reserved URL characters', () => {
    const url = 'https://x.test/a)b?c=d&e=f'
    const token = serializeLinkMentionToken(url)
    // The literal ')' in the URL must be escaped so the closing '))' delimiter
    // stays unambiguous.
    expect(token).not.toContain(')b')
    expect(token.endsWith('))')).toBe(true)
    const match = new RegExp(/\(\(mention:([^)\s]+)\)\)/).exec(token)
    expect(match).not.toBeNull()
    expect(parseLinkMentionToken(match![1])).toBe(url)
    expect(parseLinkMentionToken('%E0%A4%A')).toBeNull()
  })
})
