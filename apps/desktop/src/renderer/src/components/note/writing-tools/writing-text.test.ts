import { describe, expect, it } from 'vitest'
import { alternativeDots } from './writing-tools-plugin'
import { articleFixBefore } from './writing-text'

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

describe('alternativeDots', () => {
  it('draws one dot per version and fills the shown one', () => {
    expect(alternativeDots(1, 2)).toEqual({ count: 2, filled: 0 })
    expect(alternativeDots(2, 2)).toEqual({ count: 2, filled: 1 })
    expect(alternativeDots(4, 5)).toEqual({ count: 5, filled: 3 })
  })

  it('caps at five dots and slides the window past that', () => {
    expect(alternativeDots(1, 7)).toEqual({ count: 5, filled: 0 })
    expect(alternativeDots(3, 7)).toEqual({ count: 5, filled: 2 })
    expect(alternativeDots(4, 7)).toEqual({ count: 5, filled: 2 })
    expect(alternativeDots(6, 7)).toEqual({ count: 5, filled: 3 })
    expect(alternativeDots(7, 7)).toEqual({ count: 5, filled: 4 })
  })
})
