import { describe, expect, it } from 'vitest'
import { isAllowedExternalUrl, isPathInsideDirs, resolveMemryFilePath } from './external-url'

describe('isAllowedExternalUrl', () => {
  it('allows https, http, and mailto schemes', () => {
    expect(isAllowedExternalUrl('https://example.com')).toBe(true)
    expect(isAllowedExternalUrl('http://example.com')).toBe(true)
    expect(isAllowedExternalUrl('mailto:hi@memrynote.com')).toBe(true)
  })

  it('blocks non-web schemes', () => {
    expect(isAllowedExternalUrl('file:///etc/passwd')).toBe(false)
    expect(isAllowedExternalUrl('smb://host/share')).toBe(false)
    expect(isAllowedExternalUrl('javascript:alert(1)')).toBe(false)
    expect(isAllowedExternalUrl('memry-file://local/Users/kaan/vault/file.png')).toBe(false)
  })

  it('blocks empty and unparseable input', () => {
    expect(isAllowedExternalUrl('')).toBe(false)
    expect(isAllowedExternalUrl('not a url')).toBe(false)
  })
})

describe('resolveMemryFilePath', () => {
  it('resolves posix memry-file URLs to absolute paths', () => {
    expect(resolveMemryFilePath('memry-file://local/Users/kaan/vault/file.png', 'darwin')).toBe(
      '/Users/kaan/vault/file.png'
    )
  })

  it('decodes percent-encoded characters', () => {
    expect(
      resolveMemryFilePath('memry-file://local/Users/kaan/vault/my%20file.pdf', 'darwin')
    ).toBe('/Users/kaan/vault/my file.pdf')
  })

  it('resolves windows memry-file URLs to backslash paths', () => {
    expect(
      resolveMemryFilePath('memry-file://local/C:/Users/Leib.000/Koofr/0-WAITING/doc.pdf', 'win32')
    ).toBe('C:\\Users\\Leib.000\\Koofr\\0-WAITING\\doc.pdf')
  })

  it('normalizes traversal segments before returning', () => {
    expect(
      resolveMemryFilePath('memry-file://local/Users/kaan/vault/../secret.txt', 'darwin')
    ).toBe('/Users/kaan/secret.txt')
  })

  it('returns null for non memry-file URLs and malformed input', () => {
    expect(resolveMemryFilePath('https://example.com', 'darwin')).toBeNull()
    expect(resolveMemryFilePath('not a url', 'darwin')).toBeNull()
    expect(resolveMemryFilePath('memry-file://local/%zz', 'darwin')).toBeNull()
  })
})

describe('isPathInsideDirs', () => {
  it('matches windows backslash paths inside an allowed directory', () => {
    expect(
      isPathInsideDirs(
        'C:\\Users\\Leib.000\\Koofr\\0-WAITING\\100 Healthy Habits.pdf',
        ['C:\\Users\\Leib.000\\Koofr\\0-WAITING'],
        'win32'
      )
    ).toBe(true)
  })

  it('matches the directory itself', () => {
    expect(isPathInsideDirs('/Users/kaan/vault', ['/Users/kaan/vault'], 'darwin')).toBe(true)
  })

  it('rejects prefix-sibling directories on both platforms', () => {
    expect(
      isPathInsideDirs(
        'C:\\Users\\Leib.000\\Koofr\\0-WAITING-evil\\doc.pdf',
        ['C:\\Users\\Leib.000\\Koofr\\0-WAITING'],
        'win32'
      )
    ).toBe(false)
    expect(
      isPathInsideDirs('/Users/kaan/vault-evil/doc.pdf', ['/Users/kaan/vault'], 'darwin')
    ).toBe(false)
  })

  it('matches posix paths inside an allowed directory', () => {
    expect(isPathInsideDirs('/Users/kaan/vault/doc.pdf', ['/Users/kaan/vault'], 'darwin')).toBe(
      true
    )
  })

  it('rejects paths outside every allowed directory', () => {
    expect(
      isPathInsideDirs('C:\\Windows\\System32\\evil.dll', ['C:\\Users\\Leib.000\\Koofr'], 'win32')
    ).toBe(false)
  })
})
