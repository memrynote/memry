import { describe, it, expect } from 'vitest'
import {
  readProjectTab,
  readRailOpen,
  parseAllSort,
  parseProjectTab,
  parseRailOpen,
  PROJECT_SCROLL_KEYS,
  PROJECT_TAB_KEYS,
  PROJECT_VIEW_STATE_KEYS
} from './project-view-state'

describe('readProjectTab', () => {
  it('defaults to the All table', () => {
    expect(readProjectTab(undefined)).toBe('all')
    expect(readProjectTab({})).toBe('all')
  })

  it('rejects a value that is not a known tab', () => {
    expect(readProjectTab({ projectTab: 'canvas' })).toBe('all')
    expect(readProjectTab({ projectTab: 7 })).toBe('all')
    expect(readProjectTab({ projectTab: null })).toBe('all')
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

describe('project view-state keys', () => {
  it('keeps the names sessions on disk were written with', () => {
    // Shipped builds have persisted both under exactly these names. Renaming
    // one silently resets every project tab already open on upgrade.
    expect(PROJECT_VIEW_STATE_KEYS).toMatchObject({
      projectTab: 'projectTab',
      railOpen: 'railOpen'
    })
  })

  it('gives every sub-tab pane and the rail its own scroll key', () => {
    // A tab holds ONE scroll record, so a shared key would drop the Notes
    // offset onto Files, or the rail's onto whichever pane is beside it.
    const keys = Object.values(PROJECT_SCROLL_KEYS)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('has a scroll key for every sub-tab that owns a wrapper', () => {
    // `tasks` is deliberately absent: it has no wrapper and scrolls inside
    // `VirtualizedProjectTaskList`, which is keyed separately.
    for (const key of PROJECT_TAB_KEYS) {
      if (key === 'tasks') {
        // oxlint-disable-next-line vitest/no-conditional-expect -- table/vector-driven loop: each case asserts only the properties its row defines
        expect(PROJECT_SCROLL_KEYS).not.toHaveProperty(key)
        continue
      }
      expect(PROJECT_SCROLL_KEYS[key]).toBeTypeOf('string')
    }
  })
})

describe('project view-state readers', () => {
  it('rejects an unknown tab rather than returning it', () => {
    // The whole-record readers substitute a default; the raw parser must say
    // "no value", so `useTabViewState` can fall back to its own default.
    expect(parseProjectTab('overview')).toBe('overview')
    expect(parseProjectTab('canvas')).toBeUndefined()
    expect(parseProjectTab(7)).toBeUndefined()
    expect(parseProjectTab(null)).toBeUndefined()
    expect(parseProjectTab(undefined)).toBeUndefined()
  })

  it('accepts every known tab', () => {
    for (const key of PROJECT_TAB_KEYS) {
      expect(parseProjectTab(key)).toBe(key)
    }
  })

  it('accepts only real booleans for the rail', () => {
    // `false` must survive as a value: it is the user having closed the rail,
    // and the default is open.
    expect(parseRailOpen(false)).toBe(false)
    expect(parseRailOpen(true)).toBe(true)
    expect(parseRailOpen('no')).toBeUndefined()
    expect(parseRailOpen(0)).toBeUndefined()
  })
})

describe('parseAllSort', () => {
  it('keeps a valid sort and null (the default order)', () => {
    expect(parseAllSort({ key: 'due', dir: 'desc' })).toEqual({ key: 'due', dir: 'desc' })
    expect(parseAllSort(null)).toBeNull()
  })

  it('rejects a sort written by a build that spelled it differently', () => {
    expect(parseAllSort({ key: 'daysLeft', dir: 'asc' })).toBeUndefined()
    expect(parseAllSort({ key: 'due', dir: 'up' })).toBeUndefined()
    expect(parseAllSort('due')).toBeUndefined()
    expect(parseAllSort(undefined)).toBeUndefined()
  })
})
