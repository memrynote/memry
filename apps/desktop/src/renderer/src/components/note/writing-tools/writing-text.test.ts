import { describe, expect, it } from 'vitest'
import {
  articleFixBefore,
  countWords,
  countWordsExcluding,
  cutSpacing,
  findQuoteRanges
} from './writing-text'

function applyFix(textBefore: string, nextText: string): string {
  const fix = articleFixBefore(textBefore, nextText)
  if (!fix) return textBefore
  return textBefore.slice(0, fix.start) + fix.replacement + textBefore.slice(fix.end)
}

describe('articleFixBefore', () => {
  it.each([
    ['It was a ', 'awful idea', 'It was an '],
    ['It was an ', 'great idea', 'It was a '],
    ['A ', 'eerie silence', 'An '],
    ['An ', 'quiet room', 'A '],
    ['AN ', 'LOUD ROOM', 'A '],
    ['It was a  ', 'odd day', 'It was an  '],
    ['(a ', 'apple', '(an ']
  ])('rewrites %j before %j as %j', (textBefore, nextText, expected) => {
    expect(applyFix(textBefore, nextText)).toBe(expected)
  })

  it.each([
    ['It was a ', 'great idea'],
    ['It was an ', 'odd idea'],
    ['There was ', 'awful noise'],
    ['A banana', 'apple'],
    ['It was a', 'apple'],
    ['Plan a ', ''],
    ['Grandma ', 'apple'],
    ['ka ', 'apple']
  ])('leaves %j alone before %j', (textBefore, nextText) => {
    expect(articleFixBefore(textBefore, nextText)).toBeNull()
  })
})

describe('findQuoteRanges', () => {
  const blocks = [
    { from: 1, text: 'The cat sat on the mat. The cat left.' },
    { from: 40, text: 'It’s a “fine” day — really.' }
  ]

  it('maps quotes to document ranges in their block', () => {
    expect(findQuoteRanges(blocks, ['sat on the mat'])).toEqual([{ from: 9, to: 23, index: 0 }])
  })

  it('gives a repeated quote the next occurrence that is not taken', () => {
    expect(findQuoteRanges(blocks, ['The cat', 'The cat'])).toEqual([
      { from: 1, to: 8, index: 0 },
      { from: 25, to: 32, index: 1 }
    ])
  })

  it('matches quotes whose typographic punctuation was normalized by the model', () => {
    expect(findQuoteRanges(blocks, ['It\'s a "fine" day - really.'])).toEqual([
      { from: 40, to: 67, index: 0 }
    ])
  })

  it('accepts a quote wrapped in quotation marks', () => {
    expect(findQuoteRanges(blocks, ['"The cat left."'])).toEqual([{ from: 25, to: 38, index: 0 }])
  })

  it('drops quotes that are not verbatim or span blocks', () => {
    expect(findQuoteRanges(blocks, ['The dog sat', 'left. It’s', '', 'mat'])).toEqual([
      { from: 20, to: 23, index: 3 }
    ])
  })
})

describe('cutSpacing', () => {
  it.each([
    // "a [very] good" -> "a good"
    [' ', ' ', 'before'],
    // "a good [plan]." -> "a good."
    [' ', '.', 'before'],
    // "[Really] it" at a block start -> "it"
    ['', ' ', 'after'],
    // "([very] good)" -> "(good)"
    ['(', ' ', 'after'],
    // "very[good]" cut mid-word: nothing to absorb
    ['y', 'x', null],
    ['', '', null]
  ] as const)('between %j and %j takes the space %s', (before, after, expected) => {
    expect(cutSpacing(before, after)).toBe(expected)
  })
})

describe('word count', () => {
  it('counts words, keeping contractions and hyphenated words whole', () => {
    expect(countWords("It's a well-known fact — 3.5 times, isn’t it?")).toBe(8)
    expect(countWords('   ')).toBe(0)
  })

  it('leaves ghosted ranges out of the count', () => {
    const blocks = [
      { from: 1, text: 'one two three' },
      { from: 16, text: 'four five' }
    ]
    // Ghost "two " in block one and all of block two.
    expect(
      countWordsExcluding(blocks, [
        { from: 5, to: 9 },
        { from: 16, to: 25 }
      ])
    ).toBe(2)
  })

  it('splits a word a ghost ends inside instead of merging it with its neighbour', () => {
    // Ghosting "wo t" of "two three" leaves "t" and "hree".
    expect(countWordsExcluding([{ from: 0, text: 'two three' }], [{ from: 1, to: 5 }])).toBe(2)
  })

  it('keeps positions aligned past astral characters', () => {
    // "😀" is two UTF-16 units, so "end" starts at position 6, not 5.
    expect(countWordsExcluding([{ from: 0, text: 'go 😀 end' }], [{ from: 6, to: 9 }])).toBe(1)
  })
})
