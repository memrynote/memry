import { afterAll, beforeAll, describe, expect, it } from 'vitest'
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
  const originalTz = process.env.TZ
  beforeAll(() => {
    process.env.TZ = 'Europe/Istanbul'
  })
  afterAll(() => {
    process.env.TZ = originalTz
  })

  // The date picker stores the picked day as local midnight in ISO form.
  const picked = (day: number): string => new Date(2026, 9, day).toISOString()

  it('runs in a UTC+3 zone', () => {
    expect(picked(7)).toBe('2026-10-06T21:00:00.000Z')
  })

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
})
