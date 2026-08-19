import { describe, expect, it } from 'vitest'

import {
  CALENDAR_SCROLL_KEYS,
  CALENDAR_VIEW_STATE_KEYS,
  parseAnchorDate,
  parseCalendarBoolean,
  parseCalendarView,
  parseImportedSourceIds,
  parseVisualTypes,
  resolveAnchorSync,
  resolveSelectedSourceIds
} from './calendar-view-state'

describe('calendar view-state keys', () => {
  it('uses a distinct key per persisted value', () => {
    const keys = Object.values(CALENDAR_VIEW_STATE_KEYS)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('never collides with the navigation nonces other surfaces write', () => {
    // Agent Chat and the sidebar write `focusCalendarEventId`, `focusDate`,
    // `focusedAt` and `createEventAt` into a calendar tab's viewState. Reusing
    // one of those names would make a filter toggle re-fire a navigation.
    const nonces = ['focusCalendarEventId', 'focusDate', 'focusedAt', 'createEventAt']
    for (const key of Object.values(CALENDAR_VIEW_STATE_KEYS)) {
      expect(nonces).not.toContain(key)
    }
  })

  it('gives every scrolling view its own pane', () => {
    const keys = Object.values(CALENDAR_SCROLL_KEYS)
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe('parseCalendarView', () => {
  it('accepts the four views and nothing else', () => {
    expect(parseCalendarView('week')).toBe('week')
    expect(parseCalendarView('year')).toBe('year')
    expect(parseCalendarView('agenda')).toBeUndefined()
    expect(parseCalendarView(null)).toBeUndefined()
    expect(parseCalendarView(2)).toBeUndefined()
  })
})

describe('parseAnchorDate', () => {
  it('accepts only a plain calendar date', () => {
    // The week virtualizer turns this into a day index and the range query into
    // a local-midnight ISO string; anything else silently lands centuries away.
    expect(parseAnchorDate('2026-08-17')).toBe('2026-08-17')
    expect(parseAnchorDate('2026-08-17T09:00:00.000Z')).toBeUndefined()
    expect(parseAnchorDate('17/08/2026')).toBeUndefined()
    expect(parseAnchorDate('2026-8-7')).toBeUndefined()
    expect(parseAnchorDate(20260817)).toBeUndefined()
  })

  it('keeps `null`, which means "this tab has no anchor yet"', () => {
    expect(parseAnchorDate(null)).toBeNull()
    expect(parseAnchorDate(undefined)).toBeUndefined()
  })
})

describe('parseCalendarBoolean / parseVisualTypes', () => {
  it('takes only real booleans', () => {
    expect(parseCalendarBoolean(false)).toBe(false)
    expect(parseCalendarBoolean('false')).toBeUndefined()
    expect(parseCalendarBoolean(0)).toBeUndefined()
  })

  it('drops unknown visual types instead of rejecting the whole filter', () => {
    expect(parseVisualTypes(['event', 'wormhole', 'task'])).toEqual(['event', 'task'])
    // An empty array is a real filter — the user turned everything off.
    expect(parseVisualTypes([])).toEqual([])
    expect(parseVisualTypes('event')).toBeUndefined()
  })
})

describe('parseImportedSourceIds', () => {
  it('tells "has not chosen" apart from "chose nothing"', () => {
    expect(parseImportedSourceIds(null)).toBeNull()
    expect(parseImportedSourceIds([])).toEqual([])
    expect(parseImportedSourceIds(undefined)).toBeUndefined()
    expect(parseImportedSourceIds('src-1')).toBeUndefined()
  })

  it('keeps ids it does not recognise', () => {
    // A source can be absent because its account has not loaded yet; dropping
    // it here would quietly deselect a calendar the user had switched on.
    expect(parseImportedSourceIds(['src-1', 7, 'src-2'])).toEqual(['src-1', 'src-2'])
  })
})

describe('resolveSelectedSourceIds', () => {
  it('shows every source until the user picks a subset', () => {
    expect(resolveSelectedSourceIds(null, ['a', 'b'])).toEqual(['a', 'b'])
  })

  it('honours "chose nothing" rather than falling back to everything', () => {
    expect(resolveSelectedSourceIds([], ['a', 'b'])).toEqual([])
  })

  it('drops a source that has since disappeared', () => {
    expect(resolveSelectedSourceIds(['a', 'gone'], ['a', 'b'])).toEqual(['a'])
  })

  it('does not add a source connected after the user chose', () => {
    // Deriving "all" only applies to a tab that never chose. Once there is a
    // choice, a newly connected calendar stays off until it is switched on.
    expect(resolveSelectedSourceIds(['a'], ['a', 'b'])).toEqual(['a'])
  })
})

describe('resolveAnchorSync', () => {
  it('writes the live anchor when the tab has none', () => {
    expect(
      resolveAnchorSync({ awaitingSeed: null, anchorDate: '2026-08-17', storedAnchor: null })
    ).toEqual({ clearAwaiting: false, write: '2026-08-17' })
  })

  it('writes nothing when the tab already agrees', () => {
    expect(
      resolveAnchorSync({
        awaitingSeed: null,
        anchorDate: '2026-08-17',
        storedAnchor: '2026-08-17'
      })
    ).toEqual({ clearAwaiting: false, write: null })
  })

  it('holds the write while a restore is still in flight', () => {
    // Both effects run in the same commit: the seed has been pushed into the
    // shared context but this pass still sees the context holding today.
    // Writing here would overwrite the restored anchor with today, every launch.
    expect(
      resolveAnchorSync({
        awaitingSeed: '2026-01-05',
        anchorDate: '2026-08-17',
        storedAnchor: '2026-01-05'
      })
    ).toEqual({ clearAwaiting: false, write: null })
  })

  it('stops waiting once the context carries the seeded anchor', () => {
    expect(
      resolveAnchorSync({
        awaitingSeed: '2026-01-05',
        anchorDate: '2026-01-05',
        storedAnchor: '2026-01-05'
      })
    ).toEqual({ clearAwaiting: true, write: null })
  })

  it('resumes mirroring in the same pass the seed lands, if they differ', () => {
    // The day panel can move the anchor while the seed is still in flight; the
    // handshake must end, not strand the mirror.
    expect(
      resolveAnchorSync({
        awaitingSeed: '2026-01-05',
        anchorDate: '2026-01-05',
        storedAnchor: '2025-12-31'
      })
    ).toEqual({ clearAwaiting: true, write: '2026-01-05' })
  })

  it('mirrors a change the day panel made, which is not in a tab at all', () => {
    expect(
      resolveAnchorSync({
        awaitingSeed: null,
        anchorDate: '2026-03-02',
        storedAnchor: '2026-01-05'
      })
    ).toEqual({ clearAwaiting: false, write: '2026-03-02' })
  })
})
