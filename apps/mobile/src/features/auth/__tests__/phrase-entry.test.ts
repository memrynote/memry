import { describe, expect, it } from 'vitest'

import { PHRASE_LENGTH, emptyPhrase, spill, suggest } from '@/features/auth/phrase-entry'

const LIST = ['grain', 'granite', 'grasp', 'grass', 'harbor', 'slate']

describe('spill', () => {
  it('replaces the edited slot for a single word', () => {
    const result = spill(emptyPhrase(), 4, 'Harbor')
    expect(result.words[4]).toBe('harbor')
    expect(result.landing).toBe(4)
  })

  it('clears the slot when the text empties', () => {
    const words = emptyPhrase()
    words[0] = 'harbor'
    expect(spill(words, 0, '').words[0]).toBe('')
  })

  it('spills a pasted phrase forward from the edited slot', () => {
    const result = spill(emptyPhrase(), 2, 'harbor candle  slate')
    expect(result.words.slice(2, 5)).toEqual(['harbor', 'candle', 'slate'])
    expect(result.words[1]).toBe('')
    expect(result.landing).toBe(5)
  })

  it('fills the whole grid from a full phrase pasted into the first slot', () => {
    const phrase = Array.from({ length: PHRASE_LENGTH }, (_, i) => `w${i}`).join(' ')
    const result = spill(emptyPhrase(), 0, phrase)
    expect(result.words.every((word) => word.length > 0)).toBe(true)
    expect(result.landing).toBe(PHRASE_LENGTH - 1)
  })

  it('drops words past the end instead of wrapping', () => {
    const result = spill(emptyPhrase(), PHRASE_LENGTH - 2, 'one two three four')
    expect(result.words.slice(-2)).toEqual(['one', 'two'])
    expect(result.landing).toBe(PHRASE_LENGTH - 1)
  })
})

describe('suggest', () => {
  it('offers nothing under two characters', () => {
    expect(suggest('g', LIST)).toEqual([])
  })

  it('caps the list at three', () => {
    expect(suggest('gra', LIST)).toEqual(['grain', 'granite', 'grasp'])
  })

  it('suppresses an exact sole match', () => {
    expect(suggest('harbor', LIST)).toEqual([])
  })

  it('keeps a prefix that several words share', () => {
    expect(suggest('gras', LIST)).toEqual(['grasp', 'grass'])
  })
})
