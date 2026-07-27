import { describe, it, expect } from 'vitest'
import { readProjectTab, readRailOpen, PROJECT_TAB_KEYS } from './project-view-state'

describe('readProjectTab', () => {
  it('defaults to overview', () => {
    expect(readProjectTab(undefined)).toBe('overview')
    expect(readProjectTab({})).toBe('overview')
  })

  it('rejects a value that is not a known tab', () => {
    expect(readProjectTab({ projectTab: 'canvas' })).toBe('overview')
    expect(readProjectTab({ projectTab: 7 })).toBe('overview')
    expect(readProjectTab({ projectTab: null })).toBe('overview')
  })

  it('accepts every known tab', () => {
    for (const key of PROJECT_TAB_KEYS) {
      expect(readProjectTab({ projectTab: key })).toBe(key)
    }
  })
})

describe('readRailOpen', () => {
  it('defaults to open', () => {
    expect(readRailOpen(undefined)).toBe(true)
    expect(readRailOpen({})).toBe(true)
  })

  it('honours an explicit false', () => {
    expect(readRailOpen({ railOpen: false })).toBe(false)
  })

  it('ignores a non-boolean value', () => {
    expect(readRailOpen({ railOpen: 'no' })).toBe(true)
  })
})
