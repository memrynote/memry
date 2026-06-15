import { describe, it, expect } from 'vitest'
import { getNotionId, parseParentIds, stripNotionId } from './notion-utils'

describe('notion-utils', () => {
  it('extracts the 32-hex id from a notion name', () => {
    expect(getNotionId('My Page 0123456789abcdef0123456789abcdef.html')).toBe(
      '0123456789abcdef0123456789abcdef'
    )
  })

  it('extracts the id from a dashed UUID attribute', () => {
    expect(getNotionId('01234567-89ab-cdef-0123-456789abcdef')).toBe(
      '0123456789abcdef0123456789abcdef'
    )
  })

  it('returns undefined when there is no id', () => {
    expect(getNotionId('index.html')).toBeUndefined()
  })

  it('parses parent ids from a nested path', () => {
    const p = 'Parent 0123456789abcdef0123456789abcdef/Child fedcba9876543210fedcba9876543210.html'
    expect(parseParentIds(p)).toContain('0123456789abcdef0123456789abcdef')
  })

  it('strips the id suffix from a folder/file name', () => {
    expect(stripNotionId('My Page 0123456789abcdef0123456789abcdef')).toBe('My Page')
  })

  it('strips the id but keeps the extension', () => {
    expect(stripNotionId('cat 0123456789abcdef0123456789abcdef.png')).toBe('cat.png')
  })
})
