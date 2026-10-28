import { describe, expect, it } from 'vitest'
import { wordAtCaret, wordSpanAtOffset } from './word-at-point'

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

describe('wordAtCaret', () => {
  function field(value: string, start: number, end: number): HTMLInputElement {
    const input = document.createElement('input')
    input.value = value
    input.setSelectionRange(start, end)
    return input
  }

  it('is the word the caret is in', () => {
    expect(wordAtCaret(field('teh quick brwn fox', 12, 12))?.word).toBe('brwn')
  })

  it('is a word selected as a whole, which a right-click on it keeps selected', () => {
    expect(wordAtCaret(field('teh quick brwn fox', 0, 3))?.word).toBe('teh')
  })

  it('is nothing for a selection that is not exactly one word, because its start is not where the pointer is', () => {
    // Select-all, then a right-click on "brwn": the caret API would answer "teh".
    expect(wordAtCaret(field('teh quick brwn fox', 0, 18))).toBeNull()
    expect(wordAtCaret(field('teh quick brwn fox', 0, 2))).toBeNull()
  })
})
