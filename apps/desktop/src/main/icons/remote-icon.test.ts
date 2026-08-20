/**
 * Downloading a custom icon from a link.
 *
 * @module icons/remote-icon.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('electron', () => ({ net: {} }))
vi.mock('../lib/main-i18n', () => ({
  getMainI18n: () => ({ t: (key: string) => key })
}))
vi.mock('../lib/logger', () => ({
  createLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

const { downloadRemoteIcon, iconNameFromUrl, parseIconUrl, pickIconExtension } =
  await import('./remote-icon')

const originalFetch = globalThis.fetch

function respond(body: BodyInit | null, headers: Record<string, string>, status = 200): Response {
  return new Response(body, { status, headers })
}

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

describe('parseIconUrl', () => {
  it('accepts http and https', () => {
    expect(parseIconUrl(' https://example.com/a.png ').hostname).toBe('example.com')
    expect(parseIconUrl('http://example.com/a.png').protocol).toBe('http:')
  })

  it('rejects schemes we do not fetch', () => {
    expect(() => parseIconUrl('file:///etc/passwd')).toThrow('errors:customIcon.invalidUrl')
    expect(() => parseIconUrl('data:image/png;base64,AAAA')).toThrow('errors:customIcon.invalidUrl')
    expect(() => parseIconUrl('not a url')).toThrow('errors:customIcon.invalidUrl')
  })
})

describe('pickIconExtension', () => {
  it('trusts what the server served over the path', () => {
    const url = new URL('https://example.com/logo.txt')
    expect(pickIconExtension(url, 'image/png; charset=binary')).toBe('png')
  })

  it('falls back to the path when the type is unhelpful', () => {
    expect(pickIconExtension(new URL('https://e.com/a.JPEG'), 'application/octet-stream')).toBe(
      'jpg'
    )
    expect(pickIconExtension(new URL('https://e.com/a.svg'), null)).toBe('svg')
  })

  it('returns null when neither says image', () => {
    expect(pickIconExtension(new URL('https://e.com/page'), 'text/html')).toBeNull()
  })
})

describe('iconNameFromUrl', () => {
  it('uses the file name without its extension', () => {
    expect(iconNameFromUrl(new URL('https://e.com/icons/blue%20moon.png'))).toBe('blue moon')
  })

  it('falls back to the host', () => {
    expect(iconNameFromUrl(new URL('https://example.com/'))).toBe('example.com')
  })
})

describe('downloadRemoteIcon', () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn()
  })

  it('returns the bytes, format and a name', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      respond(Buffer.from('png-bytes'), { 'content-type': 'image/png' })
    )

    const icon = await downloadRemoteIcon('https://example.com/pics/star.png')

    expect(icon.ext).toBe('png')
    expect(icon.name).toBe('star')
    expect(icon.bytes.toString()).toBe('png-bytes')
  })

  it('rejects a non-2xx response', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(respond('nope', {}, 404))
    await expect(downloadRemoteIcon('https://example.com/a.png')).rejects.toThrow(
      'errors:customIcon.downloadFailed'
    )
  })

  it('rejects a link that is not an image', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      respond('<html>', { 'content-type': 'text/html' })
    )
    await expect(downloadRemoteIcon('https://example.com/page')).rejects.toThrow(
      'errors:customIcon.unsupportedUrl'
    )
  })

  it('stops a body that outgrows the cap even when no length is declared', async () => {
    const chunk = new Uint8Array(512 * 1024)
    let sent = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        // Would never end on its own: the cap has to be what stops it.
        sent += 1
        controller.enqueue(chunk)
        if (sent > 100) controller.close()
      }
    })
    vi.mocked(globalThis.fetch).mockResolvedValue(respond(stream, { 'content-type': 'image/png' }))

    await expect(downloadRemoteIcon('https://example.com/huge.png')).rejects.toThrow(
      'errors:customIcon.tooLarge'
    )
  })

  it('rejects an oversized body that declares its own length', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      respond(Buffer.from('x'), {
        'content-type': 'image/png',
        'content-length': String(9 * 1024 * 1024)
      })
    )
    await expect(downloadRemoteIcon('https://example.com/huge.png')).rejects.toThrow(
      'errors:customIcon.tooLarge'
    )
  })

  it('rejects an SVG that is not SVG', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      respond('<html>Access denied</html>', { 'content-type': 'image/svg+xml' })
    )
    await expect(downloadRemoteIcon('https://example.com/a.svg')).rejects.toThrow(
      'errors:customIcon.unreadableImage'
    )
  })

  it('keeps a real SVG verbatim', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      respond('<svg xmlns="http://www.w3.org/2000/svg"></svg>', {
        'content-type': 'image/svg+xml'
      })
    )
    const icon = await downloadRemoteIcon('https://example.com/a.svg')
    expect(icon.ext).toBe('svg')
    expect(icon.bytes.toString()).toContain('<svg')
  })
})
