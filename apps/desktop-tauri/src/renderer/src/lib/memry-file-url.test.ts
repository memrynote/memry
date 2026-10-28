import { afterEach, describe, expect, it } from 'vitest'
import {
  toCanonicalUrl,
  toMediaUrl,
  toMemryFileUrl,
  toWebviewUrl,
  toYoutubeEmbedUrl
} from './memry-file-url'

// Mirrors the main-process protocol handler (src/main/index.ts): it parses the
// URL, decodes the pathname, and strips the leading slash for Windows drives.
function decodeLikeProtocolHandler(url: string, platform: 'win32' | 'darwin'): string {
  const parsed = new URL(url)
  let filePath = decodeURIComponent(parsed.pathname)
  if (platform === 'win32') {
    if (filePath.startsWith('/')) filePath = filePath.slice(1)
  } else if (!filePath.startsWith('/')) {
    filePath = '/' + filePath
  }
  return filePath
}

describe('toMemryFileUrl', () => {
  it('keeps the local host and leading slash for POSIX absolute paths', () => {
    expect(toMemryFileUrl('/Users/kaan/vault/notes/file.pdf')).toBe(
      'memry-file://local/Users/kaan/vault/notes/file.pdf'
    )
  })

  it('adds the leading slash and forward slashes for Windows drive paths', () => {
    expect(toMemryFileUrl('C:\\Users\\Leib.000\\Koofr\\0-WAITING\\attachments\\doc.pdf')).toBe(
      'memry-file://local/C:/Users/Leib.000/Koofr/0-WAITING/attachments/doc.pdf'
    )
  })

  it('percent-encodes spaces in filenames', () => {
    expect(toMemryFileUrl('C:\\vault\\100 Healthy Habits.pdf')).toBe(
      'memry-file://local/C:/vault/100%20Healthy%20Habits.pdf'
    )
  })

  it('percent-encodes non-ASCII (Hebrew) filenames', () => {
    expect(toMemryFileUrl('/vault/מסמך חשוב.pdf')).toBe(
      'memry-file://local/vault/%D7%9E%D7%A1%D7%9E%D7%9A%20%D7%97%D7%A9%D7%95%D7%91.pdf'
    )
  })

  it('keeps the drive letter in the URL path, not the host', () => {
    const url = new URL(toMemryFileUrl('C:\\Users\\Leib.000\\file.pdf'))
    expect(url.host).toBe('local')
    expect(url.pathname).toBe('/C:/Users/Leib.000/file.pdf')
  })

  it('round-trips a Windows path with spaces through the protocol handler decode', () => {
    const url = toMemryFileUrl('C:\\Users\\Leib.000\\Koofr\\0-WAITING\\100 Healthy Habits.pdf')
    expect(decodeLikeProtocolHandler(url, 'win32')).toBe(
      'C:/Users/Leib.000/Koofr/0-WAITING/100 Healthy Habits.pdf'
    )
  })

  it('round-trips a POSIX Hebrew path through the protocol handler decode', () => {
    const url = toMemryFileUrl('/Users/kaan/vault/מסמך חשוב.pdf')
    expect(decodeLikeProtocolHandler(url, 'darwin')).toBe('/Users/kaan/vault/מסמך חשוב.pdf')
  })

  it('encodes URL-hostile characters so they survive the decode', () => {
    const url = toMemryFileUrl('/vault/50% off #1 draft?.pdf')
    expect(url).toBe('memry-file://local/vault/50%25%20off%20%231%20draft%3F.pdf')
    expect(decodeLikeProtocolHandler(url, 'darwin')).toBe('/vault/50% off #1 draft?.pdf')
  })
})

describe('toWebviewUrl', () => {
  it('rewrites a canonical local URL to the WebView2 form on Windows only', () => {
    expect(toWebviewUrl('memry-file://local/C:/v/a%20b.png', 'win32')).toBe(
      'https://memry-file.localhost/local/C:/v/a%20b.png'
    )
    expect(toWebviewUrl('memry-html://local/C:/v/attachments/n/a.html', 'win32')).toBe(
      'https://memry-html.localhost/local/C:/v/attachments/n/a.html'
    )
    expect(toWebviewUrl('memry-file://local/Users/k/a.png', 'darwin')).toBe(
      'memry-file://local/Users/k/a.png'
    )
    expect(toWebviewUrl('memry-file://local/Users/k/a.png', 'linux')).toBe(
      'memry-file://local/Users/k/a.png'
    )
  })

  it('adds the launch token to a Windows memry-file URL only, and only once the shell published it', () => {
    const canonical = 'memry-file://local/C:/v/a.png'
    expect(toWebviewUrl(canonical, 'win32')).toBe('https://memry-file.localhost/local/C:/v/a.png')
    window.__MEMRY_SHELL__ = {
      maximizable: true,
      loopbackOrigin: 'http://127.0.0.1:4000',
      loopbackToken: 'ab12'
    }
    try {
      expect(toWebviewUrl(canonical, 'win32')).toBe(
        'https://memry-file.localhost/local/C:/v/a.png?t=ab12'
      )
      // An embed is served without it: it needs no token and must not learn one.
      expect(toWebviewUrl('memry-html://local/C:/v/attachments/n/a.html', 'win32')).toBe(
        'https://memry-html.localhost/local/C:/v/attachments/n/a.html'
      )
      expect(toWebviewUrl(canonical, 'darwin')).toBe(canonical)
      expect(toCanonicalUrl(toWebviewUrl(canonical, 'win32'))).toBe(canonical)
    } finally {
      delete window.__MEMRY_SHELL__
    }
  })

  it('leaves other URLs alone on every platform', () => {
    for (const url of ['https://example.com/a.png', 'data:image/png;base64,AAAA', 'a/b.png', '']) {
      expect(toWebviewUrl(url, 'win32')).toBe(url)
    }
    expect(toWebviewUrl('memry-file://other/a.png', 'win32')).toBe('memry-file://other/a.png')
  })

  it('round-trips with the path the scheme handler decodes', () => {
    const canonical = toMemryFileUrl('C:\\Users\\Leib.000\\my file.pdf')
    const webview = new URL(toWebviewUrl(canonical, 'win32'))
    expect(decodeURIComponent(webview.pathname.replace(/^\/local\//, ''))).toBe(
      'C:/Users/Leib.000/my file.pdf'
    )
  })
})

describe('toCanonicalUrl', () => {
  it('undoes toWebviewUrl, and leaves any other URL alone', () => {
    for (const canonical of [
      'memry-file://local/C:/v/a%20b.png',
      'memry-html://local/C:/v/attachments/n/a.html',
      'memry-file://local'
    ]) {
      expect(toCanonicalUrl(toWebviewUrl(canonical, 'win32'))).toBe(canonical)
    }
    for (const other of [
      'memry-file://local/v/a.png',
      'https://example.com/local/a',
      'https://memry-file.localhost.evil.example/local/a',
      'data:image/png;base64,AAAA'
    ]) {
      expect(toCanonicalUrl(other)).toBe(other)
    }
  })
})

describe('toMediaUrl and toYoutubeEmbedUrl', () => {
  const globals = {
    maximizable: true,
    loopbackOrigin: 'http://127.0.0.1:4000',
    loopbackToken: 'tok'
  }

  afterEach(() => {
    delete window.__MEMRY_SHELL__
  })

  it('routes a memry-file URL through the loopback server with the URL as url-safe base64', () => {
    window.__MEMRY_SHELL__ = globals
    const url = toMemryFileUrl('/Users/k/clip ü.mp4')
    const media = toMediaUrl(url)
    expect(media.startsWith('http://127.0.0.1:4000/m/tok/')).toBe(true)
    const encoded = media.slice('http://127.0.0.1:4000/m/tok/'.length)
    expect(encoded).not.toMatch(/[+/=]/)
    const standard = encoded.replaceAll('-', '+').replaceAll('_', '/')
    const bytes = Uint8Array.from(
      atob(standard.padEnd(Math.ceil(standard.length / 4) * 4, '=')),
      (c) => c.charCodeAt(0)
    )
    expect(new TextDecoder().decode(bytes)).toBe(url)
  })

  it('falls back to the webview URL without a server or for another scheme', () => {
    expect(toMediaUrl('memry-file://local/a.mp4')).toBe('memry-file://local/a.mp4')
    window.__MEMRY_SHELL__ = globals
    expect(toMediaUrl('https://example.com/a.mp4')).toBe('https://example.com/a.mp4')
  })

  it('points a YouTube embed at the loopback page, or at YouTube when there is none', () => {
    expect(toYoutubeEmbedUrl('dQw4w9WgXcQ')).toBe(
      'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1&rel=0'
    )
    window.__MEMRY_SHELL__ = globals
    expect(toYoutubeEmbedUrl('dQw4w9WgXcQ')).toBe('http://127.0.0.1:4000/e/tok/youtube/dQw4w9WgXcQ')
  })
})
