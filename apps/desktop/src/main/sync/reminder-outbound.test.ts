import { describe, it, expect } from 'vitest'
import { toOutboundReminderPayload } from './reminder-outbound'

describe('toOutboundReminderPayload', () => {
  it('#given triggeredAt set #then always strips it from the outbound payload', () => {
    const result = toOutboundReminderPayload({
      targetType: 'note',
      status: 'pending',
      triggeredAt: '2026-05-15T08:00:01.000Z'
    })

    expect(result).not.toHaveProperty('triggeredAt')
  })

  it('#given status triggered #then normalizes it to pending', () => {
    const result = toOutboundReminderPayload({ targetType: 'note', status: 'triggered' })

    expect(result.status).toBe('pending')
  })

  it.each(['dismissed', 'snoozed', 'pending'] as const)(
    '#given status %s #then passes it through untouched',
    (status) => {
      const result = toOutboundReminderPayload({ targetType: 'note', status })

      expect(result.status).toBe(status)
    }
  )

  it('#given an anchored note_date row #then strips remindAt', () => {
    const result = toOutboundReminderPayload({
      targetType: 'note_date',
      anchorId: 'anchor-1',
      status: 'pending',
      remindAt: '2026-05-15T09:00:00.000Z'
    })

    expect(result).not.toHaveProperty('remindAt')
  })

  it('#given an unanchored note_date row (anchorId null) #then keeps remindAt', () => {
    const result = toOutboundReminderPayload({
      targetType: 'note_date',
      anchorId: null,
      status: 'pending',
      remindAt: '2026-05-15T09:00:00.000Z'
    })

    expect(result.remindAt).toBe('2026-05-15T09:00:00.000Z')
  })

  it('#given a note_date row with no anchorId field at all #then keeps remindAt', () => {
    const result = toOutboundReminderPayload({
      targetType: 'note_date',
      status: 'pending',
      remindAt: '2026-05-15T09:00:00.000Z'
    })

    expect(result.remindAt).toBe('2026-05-15T09:00:00.000Z')
  })

  it.each(['note', 'journal', 'highlight', 'task'] as const)(
    '#given a %s row (not note_date) #then keeps remindAt even with an anchorId present',
    (targetType) => {
      const result = toOutboundReminderPayload({
        targetType,
        anchorId: 'anchor-1',
        status: 'pending',
        remindAt: '2026-05-15T09:00:00.000Z'
      })

      expect(result.remindAt).toBe('2026-05-15T09:00:00.000Z')
    }
  )

  it('#then passes through unrelated fields unchanged', () => {
    const result = toOutboundReminderPayload({
      targetType: 'note',
      status: 'pending',
      id: 'rem-1',
      targetId: 'note-1',
      clock: { 'device-A': 1 }
    })

    expect(result).toMatchObject({
      id: 'rem-1',
      targetId: 'note-1',
      clock: { 'device-A': 1 }
    })
  })
})
