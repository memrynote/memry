import { describe, it, expect } from 'vitest'
import { shouldRedirectToFeatures } from './use-sidebar-navigation'

describe('shouldRedirectToFeatures', () => {
  const flags = {
    home: true,
    inbox: true,
    journal: true,
    tasks: false,
    calendar: true,
    graph: true
  }

  it('redirects a disabled feature tab', () => {
    expect(shouldRedirectToFeatures('tasks', flags)).toBe(true)
  })

  it('allows an enabled feature tab', () => {
    expect(shouldRedirectToFeatures('inbox', flags)).toBe(false)
  })

  it('allows a non-feature tab (e.g. a note)', () => {
    expect(shouldRedirectToFeatures('note', flags)).toBe(false)
  })
})
