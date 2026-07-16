import { describe, expect, it } from 'vitest'
import { matchesTagOrDescendant } from './use-task-tag-detail'

describe('matchesTagOrDescendant', () => {
  it('matches the exact tag', () => {
    expect(matchesTagOrDescendant('work', 'work')).toBe(true)
  })

  it('matches descendants', () => {
    expect(matchesTagOrDescendant('work/urgent', 'work')).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(matchesTagOrDescendant('Work/Urgent', 'work')).toBe(true)
  })

  it('does not match an unrelated prefix', () => {
    expect(matchesTagOrDescendant('workshop', 'work')).toBe(false)
  })

  it('does not match the reverse relationship (ancestor viewed as descendant)', () => {
    expect(matchesTagOrDescendant('work', 'work/urgent')).toBe(false)
  })

  it('does not match an unrelated tag', () => {
    expect(matchesTagOrDescendant('personal', 'work')).toBe(false)
  })
})
