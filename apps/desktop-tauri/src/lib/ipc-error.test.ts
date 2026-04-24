import { describe, expect, it } from 'vitest'

import { extractErrorMessage } from './ipc-error'

describe('extractErrorMessage (Tauri)', () => {
  it('returns the Error message when one is present', () => {
    expect(extractErrorMessage(new Error('boom'), 'fallback')).toBe('boom')
  })

  it('falls back to fallback when the Error message is empty', () => {
    expect(extractErrorMessage(new Error(''), 'fallback')).toBe('fallback')
  })

  it('returns raw string errors unchanged', () => {
    expect(extractErrorMessage('raw failure', 'fallback')).toBe('raw failure')
  })

  it('reads the message property of plain objects', () => {
    expect(extractErrorMessage({ message: 'object failure' }, 'fallback')).toBe('object failure')
  })

  it('falls back when an object message is empty', () => {
    expect(extractErrorMessage({ message: '' }, 'fallback')).toBe('fallback')
  })

  it('falls back for null', () => {
    expect(extractErrorMessage(null, 'fallback')).toBe('fallback')
  })

  it('falls back for undefined', () => {
    expect(extractErrorMessage(undefined, 'fallback')).toBe('fallback')
  })

  it('falls back for objects without a message field', () => {
    expect(extractErrorMessage({ code: 500 }, 'fallback')).toBe('fallback')
  })
})
