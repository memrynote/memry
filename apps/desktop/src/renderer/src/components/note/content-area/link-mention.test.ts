import { describe, expect, it } from 'vitest'

import { createLinkMentionContent, LinkMention } from './link-mention'

describe('LinkMention inline content', () => {
  it('creates link mention payloads with optional title and favicon defaults', () => {
    expect(createLinkMentionContent('https://memry.test/page', 'memry.test')).toEqual({
      type: 'linkMention',
      props: {
        url: 'https://memry.test/page',
        domain: 'memry.test',
        title: '',
        favicon: ''
      }
    })

    expect(
      createLinkMentionContent(
        'https://memry.test/page',
        'memry.test',
        'memrynote',
        'https://memry.test/favicon.ico'
      )
    ).toEqual({
      type: 'linkMention',
      props: {
        url: 'https://memry.test/page',
        domain: 'memry.test',
        title: 'memrynote',
        favicon: 'https://memry.test/favicon.ico'
      }
    })
  })

  it('renders favicon, title, data attributes, fallback text, and image error hiding', () => {
    const render = (LinkMention as any).implementation.render({
      props: {
        url: 'https://memry.test/page',
        domain: 'memry.test',
        title: 'memrynote Page',
        favicon: 'https://memry.test/favicon.ico'
      }
    })

    expect(render.dom).toHaveAttribute('href', 'https://memry.test/page')
    expect(render.dom).toHaveAttribute('target', '_blank')
    expect(render.dom).toHaveAttribute('rel', 'noopener noreferrer')
    expect(render.dom).toHaveAttribute('data-link-mention', '')
    expect(render.dom).toHaveAttribute('data-title', 'memrynote Page')
    expect(render.dom.textContent).toBe('memry.test · memrynote Page')

    const image = render.dom.querySelector('img') as HTMLImageElement
    expect(image).toHaveAttribute('src', 'https://memry.test/favicon.ico')
    image.onerror?.(new Event('error'))
    expect(image).toHaveStyle({ display: 'none' })

    const fallback = (LinkMention as any).implementation.render({
      props: {
        url: 'https://fallback.test/page',
        domain: '',
        title: '',
        favicon: ''
      }
    })
    expect(fallback.dom.textContent).toBe('https://fallback.test/page')
    expect(fallback.dom.querySelector('img')).toBeNull()
  })

  it('parses data-link mentions, legacy anchors, and rejects unknown or empty links', () => {
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
      favicon: 'https://memry.test/favicon.ico'
    })

    dataElement.setAttribute('data-url', '')
    expect((LinkMention as any).implementation.parse(dataElement)).toBeUndefined()

    const legacy = document.createElement('a')
    legacy.href = 'https://legacy.test/post'
    legacy.title = 'mention'
    legacy.textContent = 'legacy.test · Legacy Post'
    expect((LinkMention as any).implementation.parse(legacy)).toEqual({
      url: 'https://legacy.test/post',
      domain: 'legacy.test',
      title: 'Legacy Post',
      favicon: ''
    })

    const noTitle = document.createElement('a')
    noTitle.href = 'https://legacy.test/post'
    noTitle.title = 'mention'
    noTitle.textContent = 'legacy.test'
    expect((LinkMention as any).implementation.parse(noTitle)).toEqual({
      url: 'https://legacy.test/post',
      domain: 'legacy.test',
      title: '',
      favicon: ''
    })

    expect(
      (LinkMention as any).implementation.parse(document.createElement('span'))
    ).toBeUndefined()
  })

  it('serializes to external HTML with title and url fallback text', () => {
    const withTitle = (LinkMention as any).implementation.toExternalHTML({
      props: { url: 'https://memry.test/page', domain: 'memry.test', title: 'memrynote Page' }
    })
    expect(withTitle.dom).toHaveAttribute('href', 'https://memry.test/page')
    expect(withTitle.dom).toHaveAttribute('title', 'mention')
    expect(withTitle.dom.textContent).toBe('memry.test · memrynote Page')

    const withoutTitle = (LinkMention as any).implementation.toExternalHTML({
      props: { url: 'https://memry.test/page', domain: '', title: '' }
    })
    expect(withoutTitle.dom.textContent).toBe('https://memry.test/page')
  })
})
