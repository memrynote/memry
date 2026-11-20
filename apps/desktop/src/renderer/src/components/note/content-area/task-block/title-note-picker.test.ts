import { describe, expect, it } from 'vitest'
import { findNoteTrigger } from './title-note-picker'

describe('findNoteTrigger', () => {
  it('opens on an unclosed `[[` before the caret', () => {
    expect(findNoteTrigger('Call [[Ann')).toEqual({ start: 5, query: 'Ann' })
    expect(findNoteTrigger('Call [[Anna]] ')).toBeNull()
  })

  it('opens on an `@` that does not read as a date', () => {
    expect(findNoteTrigger('Check up on @Person_D')).toEqual({ start: 12, query: 'Person_D' })
    expect(findNoteTrigger('Check up on @Note A')).toEqual({ start: 12, query: 'Note A' })
  })

  it('leaves a date to the quick-add grammar', () => {
    expect(findNoteTrigger('Pay rent @tomorrow')).toBeNull()
    expect(findNoteTrigger('Pay rent @next fri')).toBeNull()
  })

  it('ignores an `@` inside a word', () => {
    expect(findNoteTrigger('mail kaan@memry')).toBeNull()
  })
})
