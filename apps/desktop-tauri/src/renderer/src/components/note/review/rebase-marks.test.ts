import { describe, expect, it } from 'vitest'
import type { CriticMarkupMark } from '@memry/shared'
import { rebaseMarks } from './rebase-marks'

function comment(text: string, plain: string, from = 0): CriticMarkupMark {
  const start = plain.indexOf(text, from)
  return {
    id: `c-${start}`,
    kind: 'comment',
    visibleText: text,
    body: 'b',
    start,
    end: start + text.length
  }
}

const covered = (plain: string, marks: CriticMarkupMark[]) =>
  marks.map((mark) => [mark.start, mark.end, plain.slice(mark.start, mark.end)])

describe('rebaseMarks', () => {
  it('moves a mark past text typed before it', () => {
    const previous = 'see test here'
    const next = 'well, see test here'
    expect(covered(next, rebaseMarks(previous, next, [comment('test', previous)]))).toEqual([
      [10, 14, 'test']
    ])
  })

  it('keeps text typed at a mark edge out of it, when the typed letter repeats its first one', () => {
    const previous = 'see test here'
    const next = 'see ttest here'
    expect(covered(next, rebaseMarks(previous, next, [comment('test', previous)]))).toEqual([
      [5, 9, 'test']
    ])
  })

  it('keeps text typed at a mark end out of it, when the typed letter repeats its last one', () => {
    const previous = 'see test here'
    const next = 'see testt here'
    expect(covered(next, rebaseMarks(previous, next, [comment('test', previous)]))).toEqual([
      [4, 8, 'test']
    ])
  })

  it('follows text deleted before a mark whose first letter the deletion ends with', () => {
    const previous = 'a t test b'
    const next = 'a test b'
    expect(covered(next, rebaseMarks(previous, next, [comment('test', previous)]))).toEqual([
      [2, 6, 'test']
    ])
  })

  it('places each mark of a batch with edits on both sides of it on its own words', () => {
    const previous = 'aa test bb test cc'
    const next = 'Xaa test bb test ccY'
    const marks = [comment('test', previous), comment('test', previous, 5)]
    expect(covered(next, rebaseMarks(previous, next, marks))).toEqual([
      [4, 8, 'test'],
      [12, 16, 'test']
    ])
  })

  it('places a mark between two inserts of one batch', () => {
    const previous = 'one two three'
    const next = 'one, two, three'
    expect(covered(next, rebaseMarks(previous, next, [comment('two', previous)]))).toEqual([
      [5, 8, 'two']
    ])
  })

  it('leaves a mark whose own words changed to the serializer', () => {
    const previous = 'see test here'
    const next = 'see tent here'
    const [mark] = rebaseMarks(previous, next, [comment('test', previous)])
    expect(mark.visibleText).toBe('test')
  })

  it('returns the marks themselves when none moved', () => {
    const previous = 'see test here'
    const next = 'see test here!'
    const marks = [comment('test', previous)]
    expect(rebaseMarks(previous, next, marks)).toBe(marks)
  })
})
