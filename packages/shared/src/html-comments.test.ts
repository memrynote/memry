import { describe, expect, it } from 'vitest'
import { stripHtmlComments } from './html-comments'

describe('stripHtmlComments', () => {
  it('removes every closed comment', () => {
    expect(stripHtmlComments('a<!-- x -->b<!--y-->c')).toBe('abc')
    expect(stripHtmlComments('<!---->')).toBe('')
  })

  it('keeps an unclosed comment and everything after it', () => {
    expect(stripHtmlComments('a<!-- x -->b<!-- open')).toBe('ab<!-- open')
    expect(stripHtmlComments('<!-->')).toBe('<!-->')
  })

  it('removes a comment re-formed by an earlier removal', () => {
    expect(stripHtmlComments('<!-<!-- x -->- y -->z')).toBe('z')
  })

  it('leaves a stray closer alone', () => {
    expect(stripHtmlComments('one <!-- a --> two <!-- b --> three -->')).toBe('one  two  three -->')
  })

  it('stays fast on many unclosed openers', () => {
    const input = '<!--'.repeat(200_000)
    const started = performance.now()
    expect(stripHtmlComments(input)).toBe(input)
    expect(performance.now() - started).toBeLessThan(1000)
  })
})
