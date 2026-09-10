import { afterEach, describe, expect, it, vi } from 'vitest'

import { fetchLinkPreview, linkDomain, parseLinkPreview } from '../link-preview'

const PAGE = 'https://www.example.com/blog/post'

function html(head: string): string {
  return `<!doctype html><html><head>${head}</head><body><p>body</p></body></html>`
}

describe('parseLinkPreview', () => {
  it('prefers Open Graph over the document title and resolves relative assets', () => {
    const preview = parseLinkPreview(
      html(`
        <title>Tab title</title>
        <meta property="og:title" content="The real title">
        <meta property="og:description" content="What it   is about">
        <meta property="og:image" content="/cover.png">
        <meta property="og:site_name" content="Example">
        <link rel="icon" href="../favicon.ico">
      `),
      PAGE
    )

    expect(preview).toEqual({
      title: 'The real title',
      domain: 'example.com',
      description: 'What it is about',
      image: 'https://www.example.com/cover.png',
      favicon: 'https://www.example.com/favicon.ico',
      siteName: 'Example'
    })
  })

  it('falls back to the document title and decodes its entities', () => {
    const preview = parseLinkPreview(html('<title>Tom &amp; Jerry &#39;96</title>'), PAGE)

    expect(preview.title).toBe("Tom & Jerry '96")
    expect(preview.description).toBe('')
  })

  it('reads a meta tag whose attributes are the other way round', () => {
    const preview = parseLinkPreview(html('<meta content="Backwards" property="og:title">'), PAGE)

    expect(preview.title).toBe('Backwards')
  })

  it('drops a bot wall title rather than bookmarking the challenge page', () => {
    const preview = parseLinkPreview(html('<title>Just a moment...</title>'), PAGE)

    expect(preview.title).toBe('')
    expect(preview.domain).toBe('example.com')
  })

  it('prefers a plain icon over an apple-touch-icon', () => {
    const preview = parseLinkPreview(
      html(`
        <link rel="apple-touch-icon" href="/tile.png">
        <link rel="shortcut icon" href="/mark.svg">
      `),
      PAGE
    )

    expect(preview.favicon).toBe('https://www.example.com/mark.svg')
  })

  it('keeps only http(s) asset references out of the page', () => {
    const preview = parseLinkPreview(
      html('<link rel="icon" href="data:image/png;base64,AAAA">'),
      PAGE
    )

    expect(preview.favicon).toBe('')
  })
})

describe('fetchLinkPreview', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function stubFetch(response: Partial<Response> & { text?: () => Promise<string> }): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        url: PAGE,
        headers: new Headers({ 'content-type': 'text/html' }),
        text: async () => '',
        ...response
      }))
    )
  }

  it('parses against the URL the response actually came from', async () => {
    stubFetch({
      url: 'https://redirected.example/final',
      text: async () => html('<link rel="icon" href="/icon.png"><title>Landed</title>')
    })

    await expect(fetchLinkPreview('https://short.test/abc')).resolves.toMatchObject({
      title: 'Landed',
      domain: 'redirected.example',
      favicon: 'https://redirected.example/icon.png'
    })
  })

  it('answers with the domain alone when the page is not HTML', async () => {
    stubFetch({
      headers: new Headers({ 'content-type': 'application/pdf' }),
      text: async () => {
        throw new Error('should not read a PDF')
      }
    })

    await expect(fetchLinkPreview(PAGE)).resolves.toEqual({
      title: '',
      domain: 'example.com',
      description: '',
      image: '',
      favicon: '',
      siteName: ''
    })
  })

  it('never rejects when the request fails outright', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline')
      })
    )

    await expect(fetchLinkPreview(PAGE)).resolves.toMatchObject({
      domain: 'example.com',
      title: ''
    })
  })

  it('answers with the domain alone on a non-2xx status', async () => {
    stubFetch({ ok: false })

    await expect(fetchLinkPreview(PAGE)).resolves.toMatchObject({
      domain: 'example.com',
      title: ''
    })
  })
})

describe('linkDomain', () => {
  it('strips www and answers empty for a string that is not a URL', () => {
    expect(linkDomain('https://www.example.com/x')).toBe('example.com')
    expect(linkDomain('https://sub.example.com')).toBe('sub.example.com')
    expect(linkDomain('not a url')).toBe('')
  })
})
