/**
 * Search API Contract Tests
 *
 * Comprehensive Zod schema validation tests for the search API.
 */

import { describe, it, expect } from 'vitest'
import { SearchQuerySchema, QuickSearchSchema, SuggestionsSchema } from './search-api'

// ============================================================================
// SearchQuerySchema Tests
// ============================================================================

describe('SearchQuerySchema', () => {
  describe('valid inputs', () => {
    it('should accept minimal valid input with just query', () => {
      const result = SearchQuerySchema.safeParse({
        query: 'meeting notes'
      })
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.query).toBe('meeting notes')
        expect(result.data.types).toEqual(['note', 'task', 'journal'])
        expect(result.data.includeArchived).toBe(false)
        expect(result.data.includeCompleted).toBe(false)
        expect(result.data.sortBy).toBe('relevance')
        expect(result.data.limit).toBe(50)
        expect(result.data.offset).toBe(0)
      }
    })

    it('should accept full valid input with all fields', () => {
      const result = SearchQuerySchema.safeParse({
        query: 'project updates',
        types: ['note', 'task'],
        tags: ['work', 'important'],
        projectId: 'proj-123',
        dateFrom: '2024-01-01',
        dateTo: '2024-12-31',
        includeArchived: true,
        includeCompleted: true,
        sortBy: 'modified',
        limit: 100,
        offset: 50
      })
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.types).toEqual(['note', 'task'])
        expect(result.data.tags).toEqual(['work', 'important'])
        expect(result.data.projectId).toBe('proj-123')
        expect(result.data.dateFrom).toBe('2024-01-01')
        expect(result.data.dateTo).toBe('2024-12-31')
        expect(result.data.includeArchived).toBe(true)
        expect(result.data.includeCompleted).toBe(true)
      }
    })

    it('should accept single character query', () => {
      const result = SearchQuerySchema.safeParse({
        query: 'a'
      })
      expect(result.success).toBe(true)
    })

    it('should accept query at maximum length (500 chars)', () => {
      const result = SearchQuerySchema.safeParse({
        query: 'a'.repeat(500)
      })
      expect(result.success).toBe(true)
    })

    it('should accept types: note only', () => {
      const result = SearchQuerySchema.safeParse({
        query: 'test',
        types: ['note']
      })
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.types).toEqual(['note'])
      }
    })

    it('should accept types: task only', () => {
      const result = SearchQuerySchema.safeParse({
        query: 'test',
        types: ['task']
      })
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.types).toEqual(['task'])
      }
    })

    it('should accept types: journal only', () => {
      const result = SearchQuerySchema.safeParse({
        query: 'test',
        types: ['journal']
      })
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.types).toEqual(['journal'])
      }
    })

    it('should accept all three types', () => {
      const result = SearchQuerySchema.safeParse({
        query: 'test',
        types: ['note', 'task', 'journal']
      })
      expect(result.success).toBe(true)
    })

    it('should accept sortBy: relevance', () => {
      const result = SearchQuerySchema.safeParse({
        query: 'test',
        sortBy: 'relevance'
      })
      expect(result.success).toBe(true)
    })

    it('should accept sortBy: modified', () => {
      const result = SearchQuerySchema.safeParse({
        query: 'test',
        sortBy: 'modified'
      })
      expect(result.success).toBe(true)
    })

    it('should accept sortBy: created', () => {
      const result = SearchQuerySchema.safeParse({
        query: 'test',
        sortBy: 'created'
      })
      expect(result.success).toBe(true)
    })

    it('should accept minimum limit (1)', () => {
      const result = SearchQuerySchema.safeParse({
        query: 'test',
        limit: 1
      })
      expect(result.success).toBe(true)
    })

    it('should accept maximum limit (200)', () => {
      const result = SearchQuerySchema.safeParse({
        query: 'test',
        limit: 200
      })
      expect(result.success).toBe(true)
    })

    it('should accept offset of 0', () => {
      const result = SearchQuerySchema.safeParse({
        query: 'test',
        offset: 0
      })
      expect(result.success).toBe(true)
    })

    it('should accept empty tags array', () => {
      const result = SearchQuerySchema.safeParse({
        query: 'test',
        tags: []
      })
      expect(result.success).toBe(true)
    })

    it('should accept ISO date strings', () => {
      const result = SearchQuerySchema.safeParse({
        query: 'test',
        dateFrom: '2024-06-15T10:30:00.000Z',
        dateTo: '2024-12-31T23:59:59.999Z'
      })
      expect(result.success).toBe(true)
    })
  })

  describe('invalid inputs', () => {
    it('should reject empty query', () => {
      const result = SearchQuerySchema.safeParse({
        query: ''
      })
      expect(result.success).toBe(false)
    })

    it('should reject missing query', () => {
      const result = SearchQuerySchema.safeParse({
        types: ['note']
      })
      expect(result.success).toBe(false)
    })

    it('should reject query exceeding 500 characters', () => {
      const result = SearchQuerySchema.safeParse({
        query: 'a'.repeat(501)
      })
      expect(result.success).toBe(false)
    })

    it('should reject invalid type in types array', () => {
      const result = SearchQuerySchema.safeParse({
        query: 'test',
        types: ['note', 'invalid']
      })
      expect(result.success).toBe(false)
    })

    it('should reject non-array types', () => {
      const result = SearchQuerySchema.safeParse({
        query: 'test',
        types: 'note'
      })
      expect(result.success).toBe(false)
    })

    it('should reject invalid sortBy value', () => {
      const result = SearchQuerySchema.safeParse({
        query: 'test',
        sortBy: 'alphabetical'
      })
      expect(result.success).toBe(false)
    })

    it('should reject limit below 1', () => {
      const result = SearchQuerySchema.safeParse({
        query: 'test',
        limit: 0
      })
      expect(result.success).toBe(false)
    })

    it('should reject limit above 200', () => {
      const result = SearchQuerySchema.safeParse({
        query: 'test',
        limit: 201
      })
      expect(result.success).toBe(false)
    })

    it('should reject negative offset', () => {
      const result = SearchQuerySchema.safeParse({
        query: 'test',
        offset: -1
      })
      expect(result.success).toBe(false)
    })

    it('should reject non-integer limit', () => {
      const result = SearchQuerySchema.safeParse({
        query: 'test',
        limit: 50.5
      })
      expect(result.success).toBe(false)
    })

    it('should reject non-integer offset', () => {
      const result = SearchQuerySchema.safeParse({
        query: 'test',
        offset: 10.5
      })
      expect(result.success).toBe(false)
    })

    it('should reject non-boolean includeArchived', () => {
      const result = SearchQuerySchema.safeParse({
        query: 'test',
        includeArchived: 'yes'
      })
      expect(result.success).toBe(false)
    })

    it('should reject non-boolean includeCompleted', () => {
      const result = SearchQuerySchema.safeParse({
        query: 'test',
        includeCompleted: 1
      })
      expect(result.success).toBe(false)
    })

    it('should reject non-string projectId', () => {
      const result = SearchQuerySchema.safeParse({
        query: 'test',
        projectId: 123
      })
      expect(result.success).toBe(false)
    })
  })
})

// ============================================================================
// QuickSearchSchema Tests
// ============================================================================

describe('QuickSearchSchema', () => {
  describe('valid inputs', () => {
    it('should accept minimal valid input with just query', () => {
      const result = QuickSearchSchema.safeParse({
        query: 'meet'
      })
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.query).toBe('meet')
        expect(result.data.limit).toBe(5)
      }
    })

    it('should accept query with custom limit', () => {
      const result = QuickSearchSchema.safeParse({
        query: 'project',
        limit: 10
      })
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.limit).toBe(10)
      }
    })

    it('should accept single character query', () => {
      const result = QuickSearchSchema.safeParse({
        query: 'a'
      })
      expect(result.success).toBe(true)
    })

    it('should accept query at maximum length (100 chars)', () => {
      const result = QuickSearchSchema.safeParse({
        query: 'a'.repeat(100)
      })
      expect(result.success).toBe(true)
    })

    it('should accept minimum limit (1)', () => {
      const result = QuickSearchSchema.safeParse({
        query: 'test',
        limit: 1
      })
      expect(result.success).toBe(true)
    })

    it('should accept maximum limit (10)', () => {
      const result = QuickSearchSchema.safeParse({
        query: 'test',
        limit: 10
      })
      expect(result.success).toBe(true)
    })
  })

  describe('invalid inputs', () => {
    it('should reject empty query', () => {
      const result = QuickSearchSchema.safeParse({
        query: ''
      })
      expect(result.success).toBe(false)
    })

    it('should reject missing query', () => {
      const result = QuickSearchSchema.safeParse({
        limit: 5
      })
      expect(result.success).toBe(false)
    })

    it('should reject query exceeding 100 characters', () => {
      const result = QuickSearchSchema.safeParse({
        query: 'a'.repeat(101)
      })
      expect(result.success).toBe(false)
    })

    it('should reject limit below 1', () => {
      const result = QuickSearchSchema.safeParse({
        query: 'test',
        limit: 0
      })
      expect(result.success).toBe(false)
    })

    it('should reject limit above 10', () => {
      const result = QuickSearchSchema.safeParse({
        query: 'test',
        limit: 11
      })
      expect(result.success).toBe(false)
    })

    it('should reject non-integer limit', () => {
      const result = QuickSearchSchema.safeParse({
        query: 'test',
        limit: 5.5
      })
      expect(result.success).toBe(false)
    })

    it('should reject non-string query', () => {
      const result = QuickSearchSchema.safeParse({
        query: 12345
      })
      expect(result.success).toBe(false)
    })
  })
})

// ============================================================================
// SuggestionsSchema Tests
// ============================================================================

describe('SuggestionsSchema', () => {
  describe('valid inputs', () => {
    it('should accept empty prefix', () => {
      const result = SuggestionsSchema.safeParse({
        prefix: ''
      })
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.prefix).toBe('')
        expect(result.data.limit).toBe(5)
      }
    })

    it('should accept prefix with custom limit', () => {
      const result = SuggestionsSchema.safeParse({
        prefix: 'meet',
        limit: 10
      })
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.prefix).toBe('meet')
        expect(result.data.limit).toBe(10)
      }
    })

    it('should accept prefix at maximum length (50 chars)', () => {
      const result = SuggestionsSchema.safeParse({
        prefix: 'a'.repeat(50)
      })
      expect(result.success).toBe(true)
    })

    it('should accept minimum limit (1)', () => {
      const result = SuggestionsSchema.safeParse({
        prefix: 'test',
        limit: 1
      })
      expect(result.success).toBe(true)
    })

    it('should accept maximum limit (10)', () => {
      const result = SuggestionsSchema.safeParse({
        prefix: 'test',
        limit: 10
      })
      expect(result.success).toBe(true)
    })

    it('should accept single character prefix', () => {
      const result = SuggestionsSchema.safeParse({
        prefix: 'a'
      })
      expect(result.success).toBe(true)
    })

    it('should accept prefix with special characters', () => {
      const result = SuggestionsSchema.safeParse({
        prefix: 'meeting-notes'
      })
      expect(result.success).toBe(true)
    })
  })

  describe('invalid inputs', () => {
    it('should reject missing prefix', () => {
      const result = SuggestionsSchema.safeParse({
        limit: 5
      })
      expect(result.success).toBe(false)
    })

    it('should reject prefix exceeding 50 characters', () => {
      const result = SuggestionsSchema.safeParse({
        prefix: 'a'.repeat(51)
      })
      expect(result.success).toBe(false)
    })

    it('should reject limit below 1', () => {
      const result = SuggestionsSchema.safeParse({
        prefix: 'test',
        limit: 0
      })
      expect(result.success).toBe(false)
    })

    it('should reject limit above 10', () => {
      const result = SuggestionsSchema.safeParse({
        prefix: 'test',
        limit: 11
      })
      expect(result.success).toBe(false)
    })

    it('should reject non-integer limit', () => {
      const result = SuggestionsSchema.safeParse({
        prefix: 'test',
        limit: 5.5
      })
      expect(result.success).toBe(false)
    })

    it('should reject non-string prefix', () => {
      const result = SuggestionsSchema.safeParse({
        prefix: 12345
      })
      expect(result.success).toBe(false)
    })

    it('should reject null prefix', () => {
      const result = SuggestionsSchema.safeParse({
        prefix: null
      })
      expect(result.success).toBe(false)
    })
  })
})
