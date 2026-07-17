import { describe, it, expect } from 'vitest'
import { buildRedirectTab } from './canvas-redirect'

describe('buildRedirectTab', () => {
  it('opens a note tab keyed by entityId', () => {
    const tab = buildRedirectTab({
      entityType: 'note',
      entityId: 'n1',
      title: 'My note',
      now: 1000
    })
    expect(tab).toMatchObject({
      type: 'note',
      title: 'My note',
      entityId: 'n1',
      path: '/note/n1'
    })
  })

  it('falls back to a default note title when empty', () => {
    expect(buildRedirectTab({ entityType: 'note', entityId: 'n1', title: '', now: 1 })?.title).toBe(
      'Note'
    )
  })

  it('opens Tasks with an openTaskId viewState', () => {
    const tab = buildRedirectTab({ entityType: 'task', entityId: 't1', title: '', now: 1 })
    expect(tab).toMatchObject({ type: 'tasks', viewState: { openTaskId: 't1' } })
  })

  it('opens Calendar focused on the event day with a fresh token', () => {
    const tab = buildRedirectTab({
      entityType: 'calendar_event',
      entityId: 'ev1',
      title: '',
      startAt: '2026-07-20T14:30:00.000Z',
      now: 9999
    })
    expect(tab).toMatchObject({
      type: 'calendar',
      viewState: {
        focusCalendarEventId: 'ev1',
        focusDate: '2026-07-20',
        focusedAt: 9999
      }
    })
  })

  it('returns null for a calendar event without a start date', () => {
    expect(
      buildRedirectTab({ entityType: 'calendar_event', entityId: 'ev1', title: '', now: 1 })
    ).toBeNull()
  })
})
