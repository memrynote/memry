/**
 * Reminder Types Contract Tests
 */

import { describe, it, expect } from 'vitest'
import {
  reminderTargetType,
  reminderStatus,
  type ReminderTargetType,
  type ReminderStatus
} from './reminder-types'

describe('reminderTargetType', () => {
  it('exposes the expected target types', () => {
    expect(reminderTargetType).toEqual({
      NOTE: 'note',
      JOURNAL: 'journal',
      HIGHLIGHT: 'highlight'
    })
  })

  it('type-checks all target values', () => {
    const values: ReminderTargetType[] = [
      reminderTargetType.NOTE,
      reminderTargetType.JOURNAL,
      reminderTargetType.HIGHLIGHT
    ]
    expect(values).toHaveLength(3)
  })
})

describe('reminderStatus', () => {
  it('exposes the expected statuses', () => {
    expect(reminderStatus).toEqual({
      PENDING: 'pending',
      TRIGGERED: 'triggered',
      DISMISSED: 'dismissed',
      SNOOZED: 'snoozed'
    })
  })

  it('type-checks all status values', () => {
    const values: ReminderStatus[] = [
      reminderStatus.PENDING,
      reminderStatus.TRIGGERED,
      reminderStatus.DISMISSED,
      reminderStatus.SNOOZED
    ]
    expect(values).toHaveLength(4)
  })

  it('values are unique lowercase strings', () => {
    const values = Object.values(reminderStatus)
    expect(new Set(values).size).toBe(values.length)
    for (const v of values) {
      expect(v).toBe(v.toLowerCase())
    }
  })
})
