import { describe, expect, it } from 'vitest'
import { isAllowedExternalUrl } from './external-url'

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
  })

  it('blocks empty and unparseable input', () => {
    expect(isAllowedExternalUrl('')).toBe(false)
    expect(isAllowedExternalUrl('not a url')).toBe(false)
  })
})
