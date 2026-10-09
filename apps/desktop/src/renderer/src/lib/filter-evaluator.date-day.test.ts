import { describe, expect, it } from 'vitest'
import { evaluateFilter } from './filter-evaluator'
import type { NoteWithProperties } from '@memry/contracts/folder-view-api'

const note = (due: unknown): NoteWithProperties => ({
  id: 'note-1',
  path: '/notes/test.md',
  title: 'Test Note',
  emoji: null,
  folder: 'notes',
  tags: [],
  created: '2026-01-01T00:00:00Z',
  modified: '2026-01-14T12:00:00Z',
  wordCount: 1,
  properties: { due }
})

describe('date filters compare date-only values as calendar days', () => {
  // Runs in the host zone; filter-date-compare.test.ts covers other zones.
  // The date picker stores the picked day as local midnight in ISO form.
  const picked = (day: number): string => new Date(2026, 9, day).toISOString()

  it('is matches the same day', () => {
    expect(evaluateFilter(note('2026-10-07'), `due == "${picked(7)}"`)).toBe(true)
    expect(evaluateFilter(note('2026-10-07'), `due != "${picked(7)}"`)).toBe(false)
    expect(evaluateFilter(note('2026-10-07'), `due == "${picked(8)}"`)).toBe(false)
  })

  it('before and after exclude the same day', () => {
    expect(evaluateFilter(note('2026-10-07'), `due after "${picked(7)}"`)).toBe(false)
    expect(evaluateFilter(note('2026-10-07'), `due before "${picked(7)}"`)).toBe(false)
    expect(evaluateFilter(note('2026-10-07'), `due after "${picked(6)}"`)).toBe(true)
    expect(evaluateFilter(note('2026-10-07'), `due before "${picked(8)}"`)).toBe(true)
  })

  it('falls back when a side is not a date', () => {
    expect(evaluateFilter(note('2026-10-07'), 'due == "soon"')).toBe(false)
    expect(evaluateFilter(note('soon'), 'due == "2026-10-07"')).toBe(false)
    expect(evaluateFilter(note('2026-10-07'), 'due after "soon"')).toBe(false)
  })

  it('compares a stored Date or timestamp with a date-only value by local day', () => {
    expect(evaluateFilter(note(new Date(2026, 9, 7, 15)), 'due == "2026-10-07"')).toBe(true)
    expect(evaluateFilter(note(new Date(2026, 9, 8, 1).getTime()), 'due after "2026-10-07"')).toBe(
      true
    )
  })

  it('keeps instant comparison when neither side is date-only', () => {
    expect(evaluateFilter(note('2026-10-07T10:00:00Z'), 'due after "2026-10-07T09:00:00Z"')).toBe(
      true
    )
  })
})
