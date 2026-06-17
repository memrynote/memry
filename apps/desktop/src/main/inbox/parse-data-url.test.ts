import { describe, it, expect } from 'vitest'
import { parseDataUrl } from './parse-data-url'

describe('parseDataUrl', () => {
  it('decodes a base64 png data URL', () => {
    // "hi" base64 = aGk=
    const r = parseDataUrl('data:image/png;base64,aGk=')
    expect(r).not.toBeNull()
    expect(r?.mime).toBe('image/png')
    expect(r?.buffer.toString('utf8')).toBe('hi')
  })

  it('returns null for a non-data string', () => {
    expect(parseDataUrl('https://example.com/x.png')).toBeNull()
  })

  it('returns null for a data URL that is not base64', () => {
    expect(parseDataUrl('data:image/png,plain')).toBeNull()
  })

  it('returns null for an empty payload', () => {
    expect(parseDataUrl('data:image/png;base64,')).toBeNull()
  })
})
