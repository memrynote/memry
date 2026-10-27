import { describe, expect, it } from 'vitest'
import { wordSpanAtOffset } from './word-at-point'

describe('wordSpanAtOffset', () => {
  const text = 'I wrote teh note, naïve don’t 42.'

  it('finds the word the offset is inside, with its bounds', () => {
    const start = text.indexOf('teh')
    expect(wordSpanAtOffset(text, start + 1)).toEqual({ word: 'teh', start, end: start + 3 })
  })

  it('finds the word a caret touches at either edge', () => {
    const start = text.indexOf('teh')
    expect(wordSpanAtOffset(text, start)?.word).toBe('teh')
    expect(wordSpanAtOffset(text, start + 3)?.word).toBe('teh')
  })

  it('keeps accented letters and an apostrophe inside the word', () => {
    expect(wordSpanAtOffset(text, text.indexOf('naïve') + 2)?.word).toBe('naïve')
    expect(wordSpanAtOffset(text, text.indexOf('don’t') + 1)?.word).toBe('don’t')
  })

  it('returns null on a space between words, punctuation and a number', () => {
    expect(wordSpanAtOffset('one  two', 4)).toBeNull()
    expect(wordSpanAtOffset('one, two', 4)).toBeNull()
    expect(wordSpanAtOffset(text, text.indexOf('42') + 1)).toBeNull()
  })

  it('returns null for empty text', () => {
    expect(wordSpanAtOffset('', 0)).toBeNull()
  })
})
