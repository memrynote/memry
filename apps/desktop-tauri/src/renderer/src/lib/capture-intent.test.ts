import { describe, it, expect } from 'vitest'
import { classifyCapture, isLikelyUrl, normalizeUrl } from './capture-intent'

describe('classifyCapture', () => {
  it.each(['https://example.com/a', 'http://example.com', 'www.example.com', 'example.com/path'])(
    'treats %s as a url',
    (input) => {
      expect(classifyCapture(input)).toBe('url')
    }
  )

  it.each([
    'Ship the beta build friday p1',
    'read example.com later',
    'multi\nline with https://x.com',
    ''
  ])('treats %j as text', (input) => {
    expect(classifyCapture(input)).toBe('text')
  })

  it('ignores surrounding whitespace', () => {
    expect(classifyCapture('  https://example.com  ')).toBe('url')
  })
})

describe('normalizeUrl', () => {
  it('keeps an explicit scheme', () => {
    expect(normalizeUrl('http://example.com')).toBe('http://example.com')
    expect(normalizeUrl('https://example.com')).toBe('https://example.com')
  })

  it('adds https to www and bare domains', () => {
    expect(normalizeUrl('www.example.com')).toBe('https://www.example.com')
    expect(normalizeUrl('example.com/path')).toBe('https://example.com/path')
  })
})

describe('isLikelyUrl', () => {
  it('rejects multi-line values', () => {
    expect(isLikelyUrl('https://example.com\nnotes')).toBe(false)
  })
})
