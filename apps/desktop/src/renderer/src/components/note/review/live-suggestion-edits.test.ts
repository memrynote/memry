import { describe, expect, it } from 'vitest'
import type { CriticMarkupMark } from '@memry/shared'
import { reconcileLiveSuggestionEdit } from './live-suggestion-edits'

function additionMark(id: string, start: number, visibleText: string): CriticMarkupMark {
  return { id, kind: 'addition', visibleText, start, end: start + visibleText.length }
}

describe('reconcileLiveSuggestionEdit newline handling', () => {
  it('shifts an addition right when newlines are inserted exactly at its start', () => {
    // Bug repro: addition typed at the end of the note ('Yoo1' right after
    // 'Hey4'); the debounced serialize inserts the '\n\n' block break at the
    // mark's start. The mark must SHIFT — never absorb '\n\n' into its
    // visibleText (serializeCriticMarkup would silently drop it).
    const prev = 'Hey4Yoo1'
    const next = 'Hey4\n\nYoo1'
    const marks = [additionMark('a1', 4, 'Yoo1')]

    const { marks: result } = reconcileLiveSuggestionEdit(prev, next, marks)

    expect(result).toEqual([additionMark('a1', 6, 'Yoo1')])
  })

  it('shifts marks left when newlines are deleted', () => {
    // The serializer can contract gap encodings (empty paragraph filled with
    // text drops one '\n'); marks after the contraction must shift left.
    const prev = 'Line4\n\n\nYoo1'
    const next = 'Line4\n\nYoo1'
    const marks = [additionMark('a1', 8, 'Yoo1')]

    const { marks: result } = reconcileLiveSuggestionEdit(prev, next, marks)

    expect(result).toEqual([additionMark('a1', 7, 'Yoo1')])
  })

  it('does not extend an addition when newlines are inserted at its end', () => {
    const prev = 'Line4\n\nKaan1Hey1'
    const next = 'Line4\n\nKaan1\n\nHey1'
    const marks = [additionMark('a1', 7, 'Kaan1')]

    const { marks: result } = reconcileLiveSuggestionEdit(prev, next, marks)

    expect(result).toEqual([additionMark('a1', 7, 'Kaan1')])
  })

  it('splits an addition in two when Enter lands inside it', () => {
    const prev = 'anchor KaanOne'
    const next = 'anchor Kaan\n\nOne'
    const marks = [additionMark('a1', 7, 'KaanOne')]

    const { marks: result, changedMarkId } = reconcileLiveSuggestionEdit(prev, next, marks)

    expect(changedMarkId).toBe('a1')
    expect(result).toHaveLength(2)
    expect(result[0]).toMatchObject({ kind: 'addition', start: 7, end: 11, visibleText: 'Kaan' })
    expect(result[1]).toMatchObject({ kind: 'addition', start: 13, end: 16, visibleText: 'One' })
  })

  it('still extends an addition for visible-text edits inside it', () => {
    const prev = 'anchor Kan'
    const next = 'anchor Kaan'
    const marks = [additionMark('a1', 7, 'Kan')]

    const { marks: result } = reconcileLiveSuggestionEdit(prev, next, marks)

    expect(result).toEqual([additionMark('a1', 7, 'Kaan')])
  })

  it('shifts marks after a pure newline insert between blocks', () => {
    const prev = 'Line4Hey1 {tail}'
    const next = 'Line4\n\nHey1 {tail}'
    const marks = [additionMark('a1', 10, '{tail}')]

    const { marks: result } = reconcileLiveSuggestionEdit(prev, next, marks)

    expect(result).toEqual([additionMark('a1', 12, '{tail}')])
  })
})
