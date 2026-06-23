import { describe, it, expect } from 'vitest'
import { createDefaultTab } from './helpers'
import { SINGLETON_TAB_TYPES } from './types'

describe('home tab', () => {
  it('home is a singleton tab type', () => {
    expect(SINGLETON_TAB_TYPES).toContain('home')
  })
  it('default tab is home', () => {
    expect(createDefaultTab().type).toBe('home')
  })
})
