import { describe, expect, it } from 'vitest'

import { TRANSIENT_TAB_VIEW_STATE_KEYS, stripTransientViewState } from './transient-view-state'

describe('stripTransientViewState', () => {
  it('drops the create-event nonce that reopened the dialog on every launch', () => {
    // The reported bug: a "New event" click weeks earlier was persisted as
    // `createEventAt` and replayed as if it had just happened.
    expect(
      stripTransientViewState({ calendarView: 'day', createEventAt: 1_700_000_000_000 })
    ).toEqual({ calendarView: 'day' })
  })

  it('drops the calendar anchor date, which is session-scoped', () => {
    expect(
      stripTransientViewState({ calendarView: 'day', calendarAnchorDate: '2026-08-08' })
    ).toEqual({ calendarView: 'day' })
  })

  it('keeps durable preferences', () => {
    const durable = {
      calendarView: 'week',
      calendarShowMemryItems: false,
      calendarImportedSourceIds: ['src-1'],
      calendarVisualTypes: ['event']
    }
    expect(stripTransientViewState(durable)).toEqual(durable)
  })

  it('drops every one-shot focus intent', () => {
    const stripped = stripTransientViewState({
      focusCalendarEventId: 'event-1',
      focusDate: '2026-08-08',
      focusedAt: 1,
      focusInboxItemId: 'inbox-1',
      focusCaptureAt: 2,
      focusQuickAddAt: 3,
      activeInternalTab: 'all'
    })
    expect(stripped).toEqual({ activeInternalTab: 'all' })
  })

  it('returns undefined rather than an empty record', () => {
    expect(stripTransientViewState({ createEventAt: 1 })).toBeUndefined()
    expect(stripTransientViewState({})).toBeUndefined()
    expect(stripTransientViewState(undefined)).toBeUndefined()
  })

  it('hands back the same object when there is nothing to strip', () => {
    // Saves churning object identity on every session save.
    const viewState = { calendarView: 'month' }
    expect(stripTransientViewState(viewState)).toBe(viewState)
  })

  it('lists no duplicate keys', () => {
    expect(new Set(TRANSIENT_TAB_VIEW_STATE_KEYS).size).toBe(TRANSIENT_TAB_VIEW_STATE_KEYS.length)
  })
})
