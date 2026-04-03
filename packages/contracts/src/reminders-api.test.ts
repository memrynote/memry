import { describe, it, expect } from 'vitest'
import {
  CreateReminderSchema,
  UpdateReminderSchema,
  SnoozeReminderSchema,
  ListRemindersSchema,
  GetForTargetSchema,
  BulkDismissSchema
} from './reminders-api'

// =============================================================================
// CreateReminderSchema (Discriminated Union) Tests
// =============================================================================

describe('CreateReminderSchema', () => {
  it('should validate note type reminder', () => {
    const result = CreateReminderSchema.safeParse({
      targetType: 'note',
      targetId: 'note-abc123',
      remindAt: '2025-01-15T09:00:00.000Z'
    })
    expect(result.success).toBe(true)
  })

  it('should validate journal type reminder', () => {
    const result = CreateReminderSchema.safeParse({
      targetType: 'journal',
      targetId: '2025-01-03',
      remindAt: '2025-01-15T09:00:00.000Z'
    })
    expect(result.success).toBe(true)
  })

  it('should validate highlight type reminder', () => {
    const result = CreateReminderSchema.safeParse({
      targetType: 'highlight',
      targetId: 'note-abc123',
      highlightText: 'Important text',
      highlightStart: 0,
      highlightEnd: 14,
      remindAt: '2025-01-15T09:00:00.000Z'
    })
    expect(result.success).toBe(true)
  })

  it('should reject highlight type without highlightText', () => {
    const result = CreateReminderSchema.safeParse({
      targetType: 'highlight',
      targetId: 'note-abc123',
      highlightStart: 0,
      highlightEnd: 10,
      remindAt: '2025-01-15T09:00:00.000Z'
    })
    expect(result.success).toBe(false)
  })

  it('should reject journal type with invalid date format', () => {
    const result = CreateReminderSchema.safeParse({
      targetType: 'journal',
      targetId: 'not-a-date',
      remindAt: '2025-01-15T09:00:00.000Z'
    })
    expect(result.success).toBe(false)
  })

  it('should reject invalid targetType', () => {
    const result = CreateReminderSchema.safeParse({
      targetType: 'task',
      targetId: 'task-123',
      remindAt: '2025-01-15T09:00:00.000Z'
    })
    expect(result.success).toBe(false)
  })
})

// =============================================================================
// UpdateReminderSchema Tests
// =============================================================================

describe('UpdateReminderSchema', () => {
  it('should validate update with only id', () => {
    const result = UpdateReminderSchema.safeParse({
      id: 'rem-abc123'
    })
    expect(result.success).toBe(true)
  })

  it('should validate update with remindAt', () => {
    const result = UpdateReminderSchema.safeParse({
      id: 'rem-abc123',
      remindAt: '2025-02-01T10:00:00.000Z'
    })
    expect(result.success).toBe(true)
  })

  it('should validate update with title and note', () => {
    const result = UpdateReminderSchema.safeParse({
      id: 'rem-abc123',
      title: 'Updated title',
      note: 'Updated note'
    })
    expect(result.success).toBe(true)
  })

  it('should validate setting title and note to null', () => {
    const result = UpdateReminderSchema.safeParse({
      id: 'rem-abc123',
      title: null,
      note: null
    })
    expect(result.success).toBe(true)
  })

  it('should reject empty id', () => {
    const result = UpdateReminderSchema.safeParse({
      id: ''
    })
    expect(result.success).toBe(false)
  })

  it('should reject missing id', () => {
    const result = UpdateReminderSchema.safeParse({
      remindAt: '2025-02-01T10:00:00.000Z'
    })
    expect(result.success).toBe(false)
  })
})

// =============================================================================
// SnoozeReminderSchema Tests
// =============================================================================

describe('SnoozeReminderSchema', () => {
  it('should validate correct snooze input', () => {
    const result = SnoozeReminderSchema.safeParse({
      id: 'rem-abc123',
      snoozeUntil: '2025-01-16T09:00:00.000Z'
    })
    expect(result.success).toBe(true)
  })

  it('should reject empty id', () => {
    const result = SnoozeReminderSchema.safeParse({
      id: '',
      snoozeUntil: '2025-01-16T09:00:00.000Z'
    })
    expect(result.success).toBe(false)
  })

  it('should reject invalid datetime format', () => {
    const result = SnoozeReminderSchema.safeParse({
      id: 'rem-abc123',
      snoozeUntil: '2025-01-16'
    })
    expect(result.success).toBe(false)
  })

  it('should reject missing snoozeUntil', () => {
    const result = SnoozeReminderSchema.safeParse({
      id: 'rem-abc123'
    })
    expect(result.success).toBe(false)
  })
})

// =============================================================================
// ListRemindersSchema Tests
// =============================================================================

describe('ListRemindersSchema', () => {
  it('should validate empty object with defaults', () => {
    const result = ListRemindersSchema.safeParse({})
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.limit).toBe(50)
      expect(result.data.offset).toBe(0)
    }
  })

  it('should validate with targetType filter', () => {
    const result = ListRemindersSchema.safeParse({
      targetType: 'note'
    })
    expect(result.success).toBe(true)
  })

  it('should validate with single status', () => {
    const result = ListRemindersSchema.safeParse({
      status: 'pending'
    })
    expect(result.success).toBe(true)
  })

  it('should validate with multiple statuses', () => {
    const result = ListRemindersSchema.safeParse({
      status: ['pending', 'snoozed']
    })
    expect(result.success).toBe(true)
  })

  it('should validate with date range', () => {
    const result = ListRemindersSchema.safeParse({
      fromDate: '2025-01-01T00:00:00.000Z',
      toDate: '2025-01-31T23:59:59.000Z'
    })
    expect(result.success).toBe(true)
  })

  it('should validate with limit and offset', () => {
    const result = ListRemindersSchema.safeParse({
      limit: 100,
      offset: 50
    })
    expect(result.success).toBe(true)
  })

  it('should reject limit below 1', () => {
    const result = ListRemindersSchema.safeParse({
      limit: 0
    })
    expect(result.success).toBe(false)
  })

  it('should reject limit above 200', () => {
    const result = ListRemindersSchema.safeParse({
      limit: 201
    })
    expect(result.success).toBe(false)
  })

  it('should reject negative offset', () => {
    const result = ListRemindersSchema.safeParse({
      offset: -1
    })
    expect(result.success).toBe(false)
  })

  it('should reject invalid targetType', () => {
    const result = ListRemindersSchema.safeParse({
      targetType: 'task'
    })
    expect(result.success).toBe(false)
  })
})

// =============================================================================
// GetForTargetSchema Tests
// =============================================================================

describe('GetForTargetSchema', () => {
  it('should validate correct input', () => {
    const result = GetForTargetSchema.safeParse({
      targetType: 'note',
      targetId: 'note-abc123'
    })
    expect(result.success).toBe(true)
  })

  it('should validate journal target', () => {
    const result = GetForTargetSchema.safeParse({
      targetType: 'journal',
      targetId: '2025-01-03'
    })
    expect(result.success).toBe(true)
  })

  it('should reject empty targetId', () => {
    const result = GetForTargetSchema.safeParse({
      targetType: 'note',
      targetId: ''
    })
    expect(result.success).toBe(false)
  })

  it('should reject missing fields', () => {
    const result = GetForTargetSchema.safeParse({
      targetType: 'note'
    })
    expect(result.success).toBe(false)
  })
})

// =============================================================================
// BulkDismissSchema Tests
// =============================================================================

describe('BulkDismissSchema', () => {
  it('should validate correct bulk dismiss input', () => {
    const result = BulkDismissSchema.safeParse({
      reminderIds: ['rem-1', 'rem-2', 'rem-3']
    })
    expect(result.success).toBe(true)
  })

  it('should validate single reminder dismiss', () => {
    const result = BulkDismissSchema.safeParse({
      reminderIds: ['rem-1']
    })
    expect(result.success).toBe(true)
  })

  it('should reject empty array', () => {
    const result = BulkDismissSchema.safeParse({
      reminderIds: []
    })
    expect(result.success).toBe(false)
  })

  it('should reject array with empty string', () => {
    const result = BulkDismissSchema.safeParse({
      reminderIds: ['rem-1', '', 'rem-3']
    })
    expect(result.success).toBe(false)
  })

  it('should reject missing reminderIds', () => {
    const result = BulkDismissSchema.safeParse({})
    expect(result.success).toBe(false)
  })
})
