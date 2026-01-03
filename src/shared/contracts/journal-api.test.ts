import { describe, it, expect } from 'vitest'
import {
  ActivityLevelSchema,
  JournalEntrySchema,
  JournalMetadataSchema,
  HeatmapEntrySchema,
  MonthStatsSchema,
  MonthEntryPreviewSchema,
  DayTaskSchema,
  ScheduleEventSchema,
  DayContextSchema,
  AIConnectionSchema,
  GetEntryInputSchema,
  CreateEntryInputSchema,
  UpdateEntryInputSchema,
  DeleteEntryInputSchema,
  GetHeatmapInputSchema,
  GetMonthEntriesInputSchema,
  GetYearStatsInputSchema,
  GetDayContextInputSchema,
  GetAllTagsOutputSchema,
  calculateActivityLevel,
  generateJournalId,
  isValidJournalDate,
  dateFromJournalId,
  countWords
} from './journal-api'

// =============================================================================
// ActivityLevelSchema Tests
// =============================================================================

describe('ActivityLevelSchema', () => {
  it('should validate activity level 0', () => {
    const result = ActivityLevelSchema.safeParse(0)
    expect(result.success).toBe(true)
  })

  it('should validate activity level 4', () => {
    const result = ActivityLevelSchema.safeParse(4)
    expect(result.success).toBe(true)
  })

  it('should reject invalid activity level', () => {
    const result = ActivityLevelSchema.safeParse(5)
    expect(result.success).toBe(false)
  })

  it('should reject negative activity level', () => {
    const result = ActivityLevelSchema.safeParse(-1)
    expect(result.success).toBe(false)
  })
})

// =============================================================================
// JournalEntrySchema Tests
// =============================================================================

describe('JournalEntrySchema', () => {
  it('should validate correct journal entry', () => {
    const result = JournalEntrySchema.safeParse({
      id: 'j2025-01-03',
      date: '2025-01-03',
      content: 'Today was productive.',
      wordCount: 3,
      characterCount: 22,
      tags: ['daily', 'work'],
      createdAt: '2025-01-03T10:00:00.000Z',
      modifiedAt: '2025-01-03T12:00:00.000Z'
    })
    expect(result.success).toBe(true)
  })

  it('should validate entry with optional properties', () => {
    const result = JournalEntrySchema.safeParse({
      id: 'j2025-01-03',
      date: '2025-01-03',
      content: '',
      wordCount: 0,
      characterCount: 0,
      tags: [],
      properties: { mood: 'happy', energy: 8 },
      createdAt: '2025-01-03T10:00:00.000Z',
      modifiedAt: '2025-01-03T12:00:00.000Z'
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.properties).toEqual({ mood: 'happy', energy: 8 })
    }
  })

  it('should reject missing required fields', () => {
    const result = JournalEntrySchema.safeParse({
      id: 'j2025-01-03',
      date: '2025-01-03'
    })
    expect(result.success).toBe(false)
  })

  it('should reject negative wordCount', () => {
    const result = JournalEntrySchema.safeParse({
      id: 'j2025-01-03',
      date: '2025-01-03',
      content: '',
      wordCount: -1,
      characterCount: 0,
      tags: [],
      createdAt: '2025-01-03T10:00:00.000Z',
      modifiedAt: '2025-01-03T12:00:00.000Z'
    })
    expect(result.success).toBe(false)
  })
})

// =============================================================================
// JournalMetadataSchema Tests
// =============================================================================

describe('JournalMetadataSchema', () => {
  it('should validate correct journal metadata', () => {
    const result = JournalMetadataSchema.safeParse({
      id: 'j2025-01-03',
      date: '2025-01-03',
      path: '/journal/2025-01-03.md',
      wordCount: 100,
      characterCount: 500,
      activityLevel: 2,
      tags: ['daily'],
      createdAt: '2025-01-03T10:00:00.000Z',
      modifiedAt: '2025-01-03T12:00:00.000Z'
    })
    expect(result.success).toBe(true)
  })

  it('should reject invalid activityLevel', () => {
    const result = JournalMetadataSchema.safeParse({
      id: 'j2025-01-03',
      date: '2025-01-03',
      path: '/journal/2025-01-03.md',
      wordCount: 100,
      characterCount: 500,
      activityLevel: 10,
      tags: [],
      createdAt: '2025-01-03T10:00:00.000Z',
      modifiedAt: '2025-01-03T12:00:00.000Z'
    })
    expect(result.success).toBe(false)
  })
})

// =============================================================================
// HeatmapEntrySchema Tests
// =============================================================================

describe('HeatmapEntrySchema', () => {
  it('should validate correct heatmap entry', () => {
    const result = HeatmapEntrySchema.safeParse({
      date: '2025-01-03',
      characterCount: 250,
      level: 2
    })
    expect(result.success).toBe(true)
  })

  it('should reject negative characterCount', () => {
    const result = HeatmapEntrySchema.safeParse({
      date: '2025-01-03',
      characterCount: -10,
      level: 0
    })
    expect(result.success).toBe(false)
  })
})

// =============================================================================
// MonthStatsSchema Tests
// =============================================================================

describe('MonthStatsSchema', () => {
  it('should validate correct month stats', () => {
    const result = MonthStatsSchema.safeParse({
      year: 2025,
      month: 1,
      entryCount: 20,
      totalWordCount: 5000,
      totalCharacterCount: 25000,
      averageLevel: 2.5
    })
    expect(result.success).toBe(true)
  })

  it('should reject month out of range', () => {
    const result = MonthStatsSchema.safeParse({
      year: 2025,
      month: 13,
      entryCount: 0,
      totalWordCount: 0,
      totalCharacterCount: 0,
      averageLevel: 0
    })
    expect(result.success).toBe(false)
  })

  it('should reject averageLevel greater than 4', () => {
    const result = MonthStatsSchema.safeParse({
      year: 2025,
      month: 6,
      entryCount: 10,
      totalWordCount: 1000,
      totalCharacterCount: 5000,
      averageLevel: 5
    })
    expect(result.success).toBe(false)
  })
})

// =============================================================================
// MonthEntryPreviewSchema Tests
// =============================================================================

describe('MonthEntryPreviewSchema', () => {
  it('should validate correct month entry preview', () => {
    const result = MonthEntryPreviewSchema.safeParse({
      date: '2025-01-03',
      preview: 'Today I worked on...',
      wordCount: 50,
      characterCount: 250,
      activityLevel: 2,
      tags: ['work', 'coding']
    })
    expect(result.success).toBe(true)
  })
})

// =============================================================================
// DayTaskSchema Tests
// =============================================================================

describe('DayTaskSchema', () => {
  it('should validate correct day task', () => {
    const result = DayTaskSchema.safeParse({
      id: 'task-123',
      title: 'Complete project',
      completed: false
    })
    expect(result.success).toBe(true)
  })

  it('should validate day task with optional fields', () => {
    const result = DayTaskSchema.safeParse({
      id: 'task-456',
      title: 'Urgent meeting',
      completed: true,
      priority: 'urgent',
      isOverdue: false
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.priority).toBe('urgent')
    }
  })

  it('should reject invalid priority', () => {
    const result = DayTaskSchema.safeParse({
      id: 'task-789',
      title: 'Task',
      completed: false,
      priority: 'critical' // Invalid priority
    })
    expect(result.success).toBe(false)
  })
})

// =============================================================================
// ScheduleEventSchema Tests
// =============================================================================

describe('ScheduleEventSchema', () => {
  it('should validate correct schedule event', () => {
    const result = ScheduleEventSchema.safeParse({
      id: 'event-123',
      time: '14:00',
      title: 'Team standup',
      type: 'meeting'
    })
    expect(result.success).toBe(true)
  })

  it('should validate event with attendeeCount', () => {
    const result = ScheduleEventSchema.safeParse({
      id: 'event-456',
      time: '10:00',
      title: 'Company all-hands',
      type: 'meeting',
      attendeeCount: 50
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.attendeeCount).toBe(50)
    }
  })

  it('should reject invalid event type', () => {
    const result = ScheduleEventSchema.safeParse({
      id: 'event-789',
      time: '09:00',
      title: 'Morning run',
      type: 'exercise' // Invalid type
    })
    expect(result.success).toBe(false)
  })
})

// =============================================================================
// DayContextSchema Tests
// =============================================================================

describe('DayContextSchema', () => {
  it('should validate correct day context', () => {
    const result = DayContextSchema.safeParse({
      date: '2025-01-03',
      tasks: [
        { id: 't1', title: 'Task 1', completed: false }
      ],
      events: [
        { id: 'e1', time: '09:00', title: 'Standup', type: 'meeting' }
      ],
      overdueCount: 2
    })
    expect(result.success).toBe(true)
  })

  it('should validate empty day context', () => {
    const result = DayContextSchema.safeParse({
      date: '2025-01-03',
      tasks: [],
      events: [],
      overdueCount: 0
    })
    expect(result.success).toBe(true)
  })
})

// =============================================================================
// AIConnectionSchema Tests
// =============================================================================

describe('AIConnectionSchema', () => {
  it('should validate journal connection', () => {
    const result = AIConnectionSchema.safeParse({
      id: 'conn-123',
      type: 'journal',
      date: '2025-01-01',
      preview: 'Similar entry from last week...',
      score: 0.85,
      matchedKeywords: ['productivity', 'goals']
    })
    expect(result.success).toBe(true)
  })

  it('should validate note connection', () => {
    const result = AIConnectionSchema.safeParse({
      id: 'conn-456',
      type: 'note',
      title: 'Project Ideas',
      preview: 'Related note about...',
      score: 0.72,
      matchedKeywords: ['project']
    })
    expect(result.success).toBe(true)
  })

  it('should reject score out of range', () => {
    const result = AIConnectionSchema.safeParse({
      id: 'conn-789',
      type: 'note',
      preview: 'Some content',
      score: 1.5, // Out of range
      matchedKeywords: []
    })
    expect(result.success).toBe(false)
  })
})

// =============================================================================
// GetEntryInputSchema Tests
// =============================================================================

describe('GetEntryInputSchema', () => {
  it('should validate correct date format', () => {
    const result = GetEntryInputSchema.safeParse({
      date: '2025-01-03'
    })
    expect(result.success).toBe(true)
  })

  it('should reject invalid date format', () => {
    const result = GetEntryInputSchema.safeParse({
      date: '01-03-2025' // Wrong format
    })
    expect(result.success).toBe(false)
  })

  it('should reject date without leading zeros', () => {
    const result = GetEntryInputSchema.safeParse({
      date: '2025-1-3' // Missing leading zeros
    })
    expect(result.success).toBe(false)
  })
})

// =============================================================================
// CreateEntryInputSchema Tests
// =============================================================================

describe('CreateEntryInputSchema', () => {
  it('should validate minimal input with defaults', () => {
    const result = CreateEntryInputSchema.safeParse({
      date: '2025-01-03'
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.content).toBe('')
      expect(result.data.tags).toEqual([])
    }
  })

  it('should validate full input', () => {
    const result = CreateEntryInputSchema.safeParse({
      date: '2025-01-03',
      content: 'Today was great!',
      tags: ['happy', 'productive'],
      properties: { mood: 'excellent' }
    })
    expect(result.success).toBe(true)
  })

  it('should reject invalid date', () => {
    const result = CreateEntryInputSchema.safeParse({
      date: 'not-a-date'
    })
    expect(result.success).toBe(false)
  })
})

// =============================================================================
// UpdateEntryInputSchema Tests
// =============================================================================

describe('UpdateEntryInputSchema', () => {
  it('should validate update with only date', () => {
    const result = UpdateEntryInputSchema.safeParse({
      date: '2025-01-03'
    })
    expect(result.success).toBe(true)
  })

  it('should validate partial update', () => {
    const result = UpdateEntryInputSchema.safeParse({
      date: '2025-01-03',
      content: 'Updated content'
    })
    expect(result.success).toBe(true)
  })

  it('should validate full update', () => {
    const result = UpdateEntryInputSchema.safeParse({
      date: '2025-01-03',
      content: 'Updated content',
      tags: ['updated'],
      properties: { mood: 'good' }
    })
    expect(result.success).toBe(true)
  })
})

// =============================================================================
// DeleteEntryInputSchema Tests
// =============================================================================

describe('DeleteEntryInputSchema', () => {
  it('should validate correct input', () => {
    const result = DeleteEntryInputSchema.safeParse({
      date: '2025-01-03'
    })
    expect(result.success).toBe(true)
  })

  it('should reject missing date', () => {
    const result = DeleteEntryInputSchema.safeParse({})
    expect(result.success).toBe(false)
  })
})

// =============================================================================
// GetHeatmapInputSchema Tests
// =============================================================================

describe('GetHeatmapInputSchema', () => {
  it('should validate correct year', () => {
    const result = GetHeatmapInputSchema.safeParse({
      year: 2025
    })
    expect(result.success).toBe(true)
  })

  it('should reject year below 1970', () => {
    const result = GetHeatmapInputSchema.safeParse({
      year: 1969
    })
    expect(result.success).toBe(false)
  })

  it('should reject year above 2100', () => {
    const result = GetHeatmapInputSchema.safeParse({
      year: 2101
    })
    expect(result.success).toBe(false)
  })
})

// =============================================================================
// GetMonthEntriesInputSchema Tests
// =============================================================================

describe('GetMonthEntriesInputSchema', () => {
  it('should validate correct year and month', () => {
    const result = GetMonthEntriesInputSchema.safeParse({
      year: 2025,
      month: 6
    })
    expect(result.success).toBe(true)
  })

  it('should reject month 0', () => {
    const result = GetMonthEntriesInputSchema.safeParse({
      year: 2025,
      month: 0
    })
    expect(result.success).toBe(false)
  })

  it('should reject month 13', () => {
    const result = GetMonthEntriesInputSchema.safeParse({
      year: 2025,
      month: 13
    })
    expect(result.success).toBe(false)
  })
})

// =============================================================================
// GetYearStatsInputSchema Tests
// =============================================================================

describe('GetYearStatsInputSchema', () => {
  it('should validate correct year', () => {
    const result = GetYearStatsInputSchema.safeParse({
      year: 2025
    })
    expect(result.success).toBe(true)
  })

  it('should reject non-integer year', () => {
    const result = GetYearStatsInputSchema.safeParse({
      year: 2025.5
    })
    expect(result.success).toBe(false)
  })
})

// =============================================================================
// GetDayContextInputSchema Tests
// =============================================================================

describe('GetDayContextInputSchema', () => {
  it('should validate correct date', () => {
    const result = GetDayContextInputSchema.safeParse({
      date: '2025-01-03'
    })
    expect(result.success).toBe(true)
  })

  it('should reject invalid date format', () => {
    const result = GetDayContextInputSchema.safeParse({
      date: '2025/01/03'
    })
    expect(result.success).toBe(false)
  })
})

// =============================================================================
// GetAllTagsOutputSchema Tests
// =============================================================================

describe('GetAllTagsOutputSchema', () => {
  it('should validate correct tags array', () => {
    const result = GetAllTagsOutputSchema.safeParse([
      { tag: 'work', count: 10 },
      { tag: 'personal', count: 5 }
    ])
    expect(result.success).toBe(true)
  })

  it('should validate empty array', () => {
    const result = GetAllTagsOutputSchema.safeParse([])
    expect(result.success).toBe(true)
  })

  it('should reject negative count', () => {
    const result = GetAllTagsOutputSchema.safeParse([
      { tag: 'work', count: -1 }
    ])
    expect(result.success).toBe(false)
  })
})

// =============================================================================
// Utility Function Tests
// =============================================================================

describe('calculateActivityLevel', () => {
  it('should return 0 for empty content', () => {
    expect(calculateActivityLevel(0)).toBe(0)
  })

  it('should return 1 for 1-100 chars', () => {
    expect(calculateActivityLevel(1)).toBe(1)
    expect(calculateActivityLevel(100)).toBe(1)
  })

  it('should return 2 for 101-500 chars', () => {
    expect(calculateActivityLevel(101)).toBe(2)
    expect(calculateActivityLevel(500)).toBe(2)
  })

  it('should return 3 for 501-1000 chars', () => {
    expect(calculateActivityLevel(501)).toBe(3)
    expect(calculateActivityLevel(1000)).toBe(3)
  })

  it('should return 4 for 1001+ chars', () => {
    expect(calculateActivityLevel(1001)).toBe(4)
    expect(calculateActivityLevel(5000)).toBe(4)
  })
})

describe('generateJournalId', () => {
  it('should generate correct ID format', () => {
    expect(generateJournalId('2025-01-03')).toBe('j2025-01-03')
  })
})

describe('isValidJournalDate', () => {
  it('should return true for valid date', () => {
    expect(isValidJournalDate('2025-01-03')).toBe(true)
  })

  it('should return false for invalid format', () => {
    expect(isValidJournalDate('01-03-2025')).toBe(false)
  })

  it('should return false for date before 1970', () => {
    expect(isValidJournalDate('1969-12-31')).toBe(false)
  })

  it('should return false for date after 2100', () => {
    expect(isValidJournalDate('2101-01-01')).toBe(false)
  })

  it('should return false for invalid date', () => {
    expect(isValidJournalDate('2025-13-01')).toBe(false)
  })
})

describe('dateFromJournalId', () => {
  it('should extract date from valid ID', () => {
    expect(dateFromJournalId('j2025-01-03')).toBe('2025-01-03')
  })

  it('should return null for invalid ID', () => {
    expect(dateFromJournalId('2025-01-03')).toBeNull()
    expect(dateFromJournalId('x2025-01-03')).toBeNull()
  })
})

describe('countWords', () => {
  it('should count words correctly', () => {
    expect(countWords('Hello world')).toBe(2)
    expect(countWords('One two three four five')).toBe(5)
  })

  it('should return 0 for empty string', () => {
    expect(countWords('')).toBe(0)
    expect(countWords('   ')).toBe(0)
  })

  it('should handle multiple spaces', () => {
    expect(countWords('Hello    world')).toBe(2)
  })
})
