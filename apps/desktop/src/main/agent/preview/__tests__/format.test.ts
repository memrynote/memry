import { describe, expect, it } from 'vitest'

import {
  asRecord,
  countWords,
  displayValue,
  excerpt,
  field,
  mergeContent,
  optionalField
} from '../format'

describe('displayValue', () => {
  /**
   * The card has to tell "not set" apart from "set to nothing", so an empty or
   * whitespace-only string collapses to null rather than rendering as a gap the
   * user cannot read.
   */
  it('reads an absent or empty value as unset', () => {
    expect(displayValue(null)).toBeNull()
    expect(displayValue(undefined)).toBeNull()
    expect(displayValue('   ')).toBeNull()
    expect(displayValue([])).toBeNull()
  })

  it('renders booleans as tokens the renderer can localize', () => {
    expect(displayValue(true)).toBe('true')
    expect(displayValue(false)).toBe('false')
  })

  it('renders a date column whatever type it arrives as', () => {
    expect(displayValue('2026-10-15')).toBe('2026-10-15')
    expect(displayValue(new Date('2026-10-15T00:00:00.000Z'))).toBe('2026-10-15T00:00:00.000Z')
    expect(displayValue(new Date('nonsense'))).toBeNull()
  })

  it('joins a tag list and drops the empties inside it', () => {
    expect(displayValue(['work', '', 'planning'])).toBe('work, planning')
  })

  /**
   * A column holding something unprintable is a missing row, never a thrown
   * preview: a preview that fails is worse than one that is a line short.
   */
  it('gives up quietly on a value it cannot print', () => {
    expect(displayValue({ nested: true })).toBeNull()
    expect(displayValue(Number.NaN)).toBeNull()
    expect(displayValue(() => 'x')).toBeNull()
  })
})

describe('field', () => {
  it('drops a row whose value does not move', () => {
    expect(field('title', 'Same', 'Same')).toBeNull()
    expect(field('due', null, undefined)).toBeNull()
  })

  it('keeps a row that moves, including one that clears a value', () => {
    expect(field('due', '2026-10-12', '2026-10-15')).toEqual({
      key: 'due',
      before: '2026-10-12',
      after: '2026-10-15'
    })
    expect(field('due', '2026-10-12', null)).toEqual({
      key: 'due',
      before: '2026-10-12',
      after: null
    })
  })
})

describe('optionalField', () => {
  /**
   * An absent key in a patch means leave alone. Treating it as a clear would
   * show the user a change the write is not going to make.
   */
  it('ignores a key the caller did not supply', () => {
    expect(optionalField('due', '2026-10-12', undefined)).toBeNull()
  })

  it('reports an explicit clear', () => {
    expect(optionalField('due', '2026-10-12', null)).toEqual({
      key: 'due',
      before: '2026-10-12',
      after: null
    })
  })
})

describe('asRecord', () => {
  it('reads anything that is not a plain object as no fields at all', () => {
    expect(asRecord(null)).toEqual({})
    expect(asRecord('text')).toEqual({})
    expect(asRecord([1, 2])).toEqual({})
    expect(asRecord({ id: 'task-1' })).toEqual({ id: 'task-1' })
  })
})

describe('mergeContent', () => {
  it('folds new text in on the side the mode names', () => {
    expect(mergeContent('kept', 'append', 'new')).toBe('kept\n\nnew')
    expect(mergeContent('kept', 'prepend', 'new')).toBe('new\n\nkept')
    expect(mergeContent('kept', 'replace', 'new')).toBe('new')
  })

  /**
   * Appending to an empty note, or appending nothing, must not leave the blank
   * line the join would otherwise add.
   */
  it('does not add a separator when one side is empty', () => {
    expect(mergeContent('', 'append', 'new')).toBe('new')
    expect(mergeContent('kept', 'append', '')).toBe('kept')
  })
})

describe('countWords and excerpt', () => {
  it('counts words across whatever whitespace separates them', () => {
    expect(countWords('  one   two\nthree\t four ')).toBe(4)
    expect(countWords('   ')).toBe(0)
  })

  it('collapses an excerpt onto one line and truncates a long one', () => {
    expect(excerpt('line one\n\nline  two')).toBe('line one line two')
    expect(excerpt('   ')).toBeNull()

    const long = excerpt('x'.repeat(400))
    expect(long).toHaveLength(240)
    expect(long?.endsWith('\u2026')).toBe(true)
  })
})
