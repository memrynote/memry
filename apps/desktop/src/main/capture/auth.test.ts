import { describe, it, expect } from 'vitest'
import { validateCaptureRequest, isExtensionOrigin } from './auth'

const TOKEN = 'a'.repeat(64)
const allow = (o: string | undefined) => o === 'chrome-extension://abc'
const good = {
  authorization: `Bearer ${TOKEN}`,
  origin: 'chrome-extension://abc',
  'x-memry-capture': '1'
}

describe('validateCaptureRequest', () => {
  it('accepts a fully valid request', () => {
    expect(validateCaptureRequest(good, TOKEN, allow)).toEqual({ ok: true })
  })
  it('rejects a missing/blank token', () => {
    expect(validateCaptureRequest({ ...good, authorization: undefined }, TOKEN, allow).ok).toBe(
      false
    )
  })
  it('rejects a wrong token', () => {
    expect(validateCaptureRequest({ ...good, authorization: 'Bearer nope' }, TOKEN, allow).ok).toBe(
      false
    )
  })
  it('rejects a non-allowlisted origin', () => {
    expect(validateCaptureRequest({ ...good, origin: 'https://evil.com' }, TOKEN, allow).ok).toBe(
      false
    )
  })
  it('rejects a missing custom header', () => {
    expect(validateCaptureRequest({ ...good, 'x-memry-capture': undefined }, TOKEN, allow).ok).toBe(
      false
    )
  })
  it('rejects a same-length but different token', () => {
    expect(
      validateCaptureRequest({ ...good, authorization: `Bearer ${'b'.repeat(64)}` }, TOKEN, allow)
        .ok
    ).toBe(false)
  })
})

describe('isExtensionOrigin', () => {
  it('accepts a Safari web-extension origin', () => {
    expect(isExtensionOrigin('safari-web-extension://A1B2C3D4-0000-0000-0000-000000000000')).toBe(
      true
    )
  })
  it('accepts chrome and firefox extension origins', () => {
    expect(isExtensionOrigin('chrome-extension://abc')).toBe(true)
    expect(isExtensionOrigin('moz-extension://abc')).toBe(true)
  })
  it('rejects a web origin and undefined', () => {
    expect(isExtensionOrigin('https://evil.com')).toBe(false)
    expect(isExtensionOrigin(undefined)).toBe(false)
  })
})
