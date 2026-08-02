import { describe, it, expect, vi } from 'vitest'
import { openLinkedEvent } from './open-linked-item'

describe('openLinkedEvent', () => {
  it('opens the calendar on the event day with the event focused', () => {
    const openTab = vi.fn()

    openLinkedEvent(
      {
        id: 'e1',
        title: 'Review',
        startAt: '2026-08-08T14:00:00.000Z',
        endAt: null,
        isAllDay: false
      },
      openTab,
      1_700_000_000
    )

    expect(openTab).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'calendar',
        path: '/calendar',
        viewState: {
          focusCalendarEventId: 'e1',
          focusDate: '2026-08-08',
          focusedAt: 1_700_000_000
        }
      })
    )
  })

  it('does nothing when the event has no start date to focus', () => {
    const openTab = vi.fn()

    openLinkedEvent(
      { id: 'e2', title: 'Undated', startAt: '', endAt: null, isAllDay: true },
      openTab,
      1
    )

    expect(openTab).not.toHaveBeenCalled()
  })
})
