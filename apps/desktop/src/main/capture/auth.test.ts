import { describe, it, expect } from 'vitest'
import { validateCaptureRequest } from './auth'

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
})
