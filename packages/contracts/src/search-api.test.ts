/**
 * Search API Contract Tests
 */

import { describe, it, expect } from 'vitest'
import {
  ContentTypeEnum,
  DateRangeSchema,
  SearchQuerySchema,
  AddReasonSchema
} from './search-api'

describe('ContentTypeEnum', () => {
  it('accepts all valid content types', () => {
    for (const t of ['note', 'journal', 'task', 'inbox']) {
      expect(ContentTypeEnum.safeParse(t).success).toBe(true)
    }
  })

  it('rejects invalid content type', () => {
    expect(ContentTypeEnum.safeParse('file').success).toBe(false)
  })
})

describe('DateRangeSchema', () => {
  it('accepts valid range', () => {
    const result = DateRangeSchema.safeParse({ from: '2026-04-01', to: '2026-04-30' })
    expect(result.success).toBe(true)
  })

  it('rejects missing to', () => {
    const result = DateRangeSchema.safeParse({ from: '2026-04-01' })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].path).toContain('to')
    }
  })

  it('rejects non-string from', () => {
    const result = DateRangeSchema.safeParse({ from: 20260401, to: '2026-04-30' })
    expect(result.success).toBe(false)
  })
})

describe('SearchQuerySchema', () => {
  it('accepts minimal input with defaults', () => {
    const result = SearchQuerySchema.safeParse({ text: 'meeting' })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.types).toEqual([])
      expect(result.data.tags).toEqual([])
      expect(result.data.dateRange).toBeNull()
      expect(result.data.projectId).toBeNull()
      expect(result.data.folderPath).toBeNull()
      expect(result.data.limit).toBe(10)
      expect(result.data.offset).toBe(0)
    }
  })

  it('accepts full query', () => {
    const result = SearchQuerySchema.safeParse({
      text: 'meeting',
      types: ['note', 'task'],
      tags: ['work'],
      dateRange: { from: '2026-04-01', to: '2026-04-30' },
      projectId: 'proj-1',
      folderPath: '/notes',
      limit: 50,
      offset: 20
    })
    expect(result.success).toBe(true)
  })

  it('accepts empty text (no min)', () => {
    const result = SearchQuerySchema.safeParse({ text: '' })
    expect(result.success).toBe(true)
  })

  it('rejects text over 500 chars', () => {
    const result = SearchQuerySchema.safeParse({ text: 'x'.repeat(501) })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].path).toContain('text')
    }
  })

  it('accepts text at 500 char boundary', () => {
    const result = SearchQuerySchema.safeParse({ text: 'x'.repeat(500) })
    expect(result.success).toBe(true)
  })

  it('rejects invalid content type in types array', () => {
    const result = SearchQuerySchema.safeParse({ text: 'q', types: ['bogus'] })
    expect(result.success).toBe(false)
  })

  it('rejects limit below 1', () => {
    const result = SearchQuerySchema.safeParse({ text: 'q', limit: 0 })
    expect(result.success).toBe(false)
  })

  it('rejects limit above 100', () => {
    const result = SearchQuerySchema.safeParse({ text: 'q', limit: 101 })
    expect(result.success).toBe(false)
  })

  it('accepts limit at boundaries', () => {
    expect(SearchQuerySchema.safeParse({ text: 'q', limit: 1 }).success).toBe(true)
    expect(SearchQuerySchema.safeParse({ text: 'q', limit: 100 }).success).toBe(true)
  })

  it('rejects negative offset', () => {
    const result = SearchQuerySchema.safeParse({ text: 'q', offset: -1 })
    expect(result.success).toBe(false)
  })

  it('accepts explicit null dateRange', () => {
    const result = SearchQuerySchema.safeParse({ text: 'q', dateRange: null })
    expect(result.success).toBe(true)
  })

  it('rejects invalid dateRange shape', () => {
    const result = SearchQuerySchema.safeParse({
      text: 'q',
      dateRange: { from: '2026-04-01' }
    })
    expect(result.success).toBe(false)
  })
})

describe('AddReasonSchema', () => {
  it('accepts minimal valid input with default icon null', () => {
    const result = AddReasonSchema.safeParse({
      itemId: 'i1',
      itemType: 'note',
      itemTitle: 'Note',
      searchQuery: 'q'
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.itemIcon).toBeNull()
    }
  })

  it('accepts itemIcon string', () => {
    const result = AddReasonSchema.safeParse({
      itemId: 'i1',
      itemType: 'task',
      itemTitle: 'T',
      itemIcon: '📝',
      searchQuery: 'q'
    })
    expect(result.success).toBe(true)
  })

  it('rejects empty itemId', () => {
    const result = AddReasonSchema.safeParse({
      itemId: '',
      itemType: 'note',
      itemTitle: 'Note',
      searchQuery: 'q'
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].path).toContain('itemId')
    }
  })

  it('rejects invalid itemType', () => {
    const result = AddReasonSchema.safeParse({
      itemId: 'i1',
      itemType: 'file',
      itemTitle: 'Note',
      searchQuery: 'q'
    })
    expect(result.success).toBe(false)
  })

  it('rejects empty searchQuery', () => {
    const result = AddReasonSchema.safeParse({
      itemId: 'i1',
      itemType: 'note',
      itemTitle: 'Note',
      searchQuery: ''
    })
    expect(result.success).toBe(false)
  })
})
