import { describe, expect, it } from 'vitest'
import { toMemryFileUrl } from './memry-file-url'

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
