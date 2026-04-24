// ============================================================================
// FILTER EVALUATOR TESTS
// ============================================================================
// Tests for src/renderer/src/lib/filter-evaluator.ts
// Tasks: T042-T056

import { describe, it, expect, vi } from 'vitest'
import {
  evaluateFilter,
  parseExpression,
  serializeCondition,
  getOperatorsForType,
  getDefaultOperator,
  countFilterConditions,
  isFilterEmpty,
  createSimpleFilter,
  combineFiltersAnd,
  combineFiltersOr,
  type PropertyType,
  type ParsedCondition
} from './filter-evaluator'
import type { NoteWithProperties, FilterExpression } from '@memry/contracts/folder-view-api'

vi.mock('@/lib/logger', () => ({
  createLogger: vi.fn(() => ({
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn()
  }))
}))

// ============================================================================
// TEST UTILITIES
// ============================================================================

/**
 * Create a mock note with default values and optional overrides
 */
const createMockNote = (overrides?: Partial<NoteWithProperties>): NoteWithProperties => {
  const defaultProperties = {
    status: 'active',
    priority: 3,
    completed: false,
    due: '2026-01-20',
    rating: 4,
    url: 'https://example.com',
    category: ['work', 'urgent']
  }

  return {
    id: 'note-1',
    path: '/notes/test.md',
    title: 'Test Note',
    emoji: null,
    folder: 'notes',
    tags: ['tag1', 'tag2'],
    created: '2026-01-01T00:00:00Z',
    modified: '2026-01-14T12:00:00Z',
    wordCount: 100,
    ...overrides,
    properties: {
      ...defaultProperties,
      ...overrides?.properties
    }
  }
}

// ============================================================================
// T042: TEST STRUCTURE
// ============================================================================

describe('Filter Evaluator', () => {
  // ==========================================================================
  // T043: TEXT OPERATORS
  // ==========================================================================

  describe('Text Operators (T043)', () => {
    describe('equality (==)', () => {
      it('should match exact string values', () => {
        const note = createMockNote({ title: 'Hello World' })
        expect(evaluateFilter(note, 'title == "Hello World"')).toBe(true)
      })

      it('should be case-insensitive', () => {
        const note = createMockNote({ title: 'Hello World' })
        expect(evaluateFilter(note, 'title == "hello world"')).toBe(true)
        expect(evaluateFilter(note, 'title == "HELLO WORLD"')).toBe(true)
      })

      it('should not match different values', () => {
        const note = createMockNote({ title: 'Hello World' })
        expect(evaluateFilter(note, 'title == "Goodbye"')).toBe(false)
      })
    })

    describe('inequality (!=)', () => {
      it('should not match equal values', () => {
        const note = createMockNote({ title: 'Hello World' })
        expect(evaluateFilter(note, 'title != "Hello World"')).toBe(false)
      })

      it('should match different values', () => {
        const note = createMockNote({ title: 'Hello World' })
        expect(evaluateFilter(note, 'title != "Goodbye"')).toBe(true)
      })

      it('should be case-insensitive', () => {
        const note = createMockNote({ title: 'Hello World' })
        expect(evaluateFilter(note, 'title != "hello world"')).toBe(false)
      })
    })

    describe('contains', () => {
      it('should match when string contains value', () => {
        const note = createMockNote({ title: 'Hello World' })
        expect(evaluateFilter(note, 'title contains "World"')).toBe(true)
        expect(evaluateFilter(note, 'title contains "ello"')).toBe(true)
      })

      it('should be case-insensitive', () => {
        const note = createMockNote({ title: 'Hello World' })
        expect(evaluateFilter(note, 'title contains "world"')).toBe(true)
        expect(evaluateFilter(note, 'title contains "HELLO"')).toBe(true)
      })

      it('should not match when string does not contain value', () => {
        const note = createMockNote({ title: 'Hello World' })
        expect(evaluateFilter(note, 'title contains "Foo"')).toBe(false)
      })
    })

    describe('notContains', () => {
      it('should match when string does not contain value', () => {
        const note = createMockNote({ title: 'Hello World' })
        expect(evaluateFilter(note, 'title notContains "Foo"')).toBe(true)
      })

      it('should not match when string contains value', () => {
        const note = createMockNote({ title: 'Hello World' })
        expect(evaluateFilter(note, 'title notContains "World"')).toBe(false)
      })
    })

    describe('startsWith', () => {
      it('should match when string starts with value', () => {
        const note = createMockNote({ title: 'Hello World' })
        expect(evaluateFilter(note, 'title startsWith "Hello"')).toBe(true)
      })

      it('should be case-insensitive', () => {
        const note = createMockNote({ title: 'Hello World' })
        expect(evaluateFilter(note, 'title startsWith "hello"')).toBe(true)
      })

      it('should not match when string does not start with value', () => {
        const note = createMockNote({ title: 'Hello World' })
        expect(evaluateFilter(note, 'title startsWith "World"')).toBe(false)
      })
    })

    describe('endsWith', () => {
      it('should match when string ends with value', () => {
        const note = createMockNote({ title: 'Hello World' })
        expect(evaluateFilter(note, 'title endsWith "World"')).toBe(true)
      })

      it('should be case-insensitive', () => {
        const note = createMockNote({ title: 'Hello World' })
        expect(evaluateFilter(note, 'title endsWith "world"')).toBe(true)
      })

      it('should not match when string does not end with value', () => {
        const note = createMockNote({ title: 'Hello World' })
        expect(evaluateFilter(note, 'title endsWith "Hello"')).toBe(false)
      })
    })

    describe('isEmpty', () => {
      it('should match null values', () => {
        const note = createMockNote({ properties: { status: null } })
        expect(evaluateFilter(note, 'status isEmpty')).toBe(true)
      })

      it('should match undefined values', () => {
        const note = createMockNote({ properties: { status: undefined } })
        expect(evaluateFilter(note, 'status isEmpty')).toBe(true)
      })

      it('should match empty strings', () => {
        const note = createMockNote({ properties: { status: '' } })
        expect(evaluateFilter(note, 'status isEmpty')).toBe(true)
      })

      it('should match whitespace-only strings', () => {
        const note = createMockNote({ properties: { status: '   ' } })
        expect(evaluateFilter(note, 'status isEmpty')).toBe(true)
      })

      it('should not match non-empty values', () => {
        const note = createMockNote({ properties: { status: 'active' } })
        expect(evaluateFilter(note, 'status isEmpty')).toBe(false)
      })

      it('should match empty arrays', () => {
        const note = createMockNote({ properties: { category: [] } })
        expect(evaluateFilter(note, 'category isEmpty')).toBe(true)
      })
    })

    describe('isNotEmpty', () => {
      it('should match non-empty values', () => {
        const note = createMockNote({ properties: { status: 'active' } })
        expect(evaluateFilter(note, 'status isNotEmpty')).toBe(true)
      })

      it('should not match empty values', () => {
        const note = createMockNote({ properties: { status: '' } })
        expect(evaluateFilter(note, 'status isNotEmpty')).toBe(false)
      })

      it('should match non-empty arrays', () => {
        const note = createMockNote({ properties: { category: ['work'] } })
        expect(evaluateFilter(note, 'category isNotEmpty')).toBe(true)
      })
    })
  })

  // ==========================================================================
  // T044: NUMBER OPERATORS
  // ==========================================================================

  describe('Number Operators (T044)', () => {
    describe('equality (==)', () => {
      it('should match equal numbers', () => {
        const note = createMockNote({ properties: { priority: 3 } })
        expect(evaluateFilter(note, 'priority == 3')).toBe(true)
      })

      it('should not match different numbers', () => {
        const note = createMockNote({ properties: { priority: 3 } })
        expect(evaluateFilter(note, 'priority == 5')).toBe(false)
      })

      it('should NOT coerce string to number for equality (strict comparison)', () => {
        // Note: The evaluator uses strict equality for == operator
        // String "3" !== number 3
        const note = createMockNote({ properties: { priority: '3' } })
        expect(evaluateFilter(note, 'priority == 3')).toBe(false)
        // Use string comparison instead
        expect(evaluateFilter(note, 'priority == "3"')).toBe(true)
      })
    })

    describe('inequality (!=)', () => {
      it('should match different numbers', () => {
        const note = createMockNote({ properties: { priority: 3 } })
        expect(evaluateFilter(note, 'priority != 5')).toBe(true)
      })

      it('should not match equal numbers', () => {
        const note = createMockNote({ properties: { priority: 3 } })
        expect(evaluateFilter(note, 'priority != 3')).toBe(false)
      })
    })

    describe('greater than (>)', () => {
      it('should match when value is greater', () => {
        const note = createMockNote({ properties: { priority: 5 } })
        expect(evaluateFilter(note, 'priority > 3')).toBe(true)
      })

      it('should not match when value is equal', () => {
        const note = createMockNote({ properties: { priority: 3 } })
        expect(evaluateFilter(note, 'priority > 3')).toBe(false)
      })

      it('should not match when value is less', () => {
        const note = createMockNote({ properties: { priority: 1 } })
        expect(evaluateFilter(note, 'priority > 3')).toBe(false)
      })
    })

    describe('greater than or equal (>=)', () => {
      it('should match when value is greater', () => {
        const note = createMockNote({ properties: { priority: 5 } })
        expect(evaluateFilter(note, 'priority >= 3')).toBe(true)
      })

      it('should match when value is equal', () => {
        const note = createMockNote({ properties: { priority: 3 } })
        expect(evaluateFilter(note, 'priority >= 3')).toBe(true)
      })

      it('should not match when value is less', () => {
        const note = createMockNote({ properties: { priority: 1 } })
        expect(evaluateFilter(note, 'priority >= 3')).toBe(false)
      })
    })

    describe('less than (<)', () => {
      it('should match when value is less', () => {
        const note = createMockNote({ properties: { priority: 1 } })
        expect(evaluateFilter(note, 'priority < 3')).toBe(true)
      })

      it('should not match when value is equal', () => {
        const note = createMockNote({ properties: { priority: 3 } })
        expect(evaluateFilter(note, 'priority < 3')).toBe(false)
      })

      it('should not match when value is greater', () => {
        const note = createMockNote({ properties: { priority: 5 } })
        expect(evaluateFilter(note, 'priority < 3')).toBe(false)
      })
    })

    describe('less than or equal (<=)', () => {
      it('should match when value is less', () => {
        const note = createMockNote({ properties: { priority: 1 } })
        expect(evaluateFilter(note, 'priority <= 3')).toBe(true)
      })

      it('should match when value is equal', () => {
        const note = createMockNote({ properties: { priority: 3 } })
        expect(evaluateFilter(note, 'priority <= 3')).toBe(true)
      })

      it('should not match when value is greater', () => {
        const note = createMockNote({ properties: { priority: 5 } })
        expect(evaluateFilter(note, 'priority <= 3')).toBe(false)
      })
    })

    describe('wordCount built-in property', () => {
      it('should compare wordCount correctly', () => {
        const note = createMockNote({ wordCount: 100 })
        expect(evaluateFilter(note, 'wordCount >= 50')).toBe(true)
        expect(evaluateFilter(note, 'wordCount < 200')).toBe(true)
        expect(evaluateFilter(note, 'wordCount == 100')).toBe(true)
      })
    })
  })

  // ==========================================================================
  // T045: DATE OPERATORS
  // ==========================================================================

  describe('Date Operators (T045)', () => {
    describe('equality (==)', () => {
      it('should match equal dates', () => {
        const note = createMockNote({ properties: { due: '2026-01-20' } })
        expect(evaluateFilter(note, 'due == "2026-01-20"')).toBe(true)
      })
    })

    describe('before', () => {
      it('should match when date is before', () => {
        const note = createMockNote({ properties: { due: '2026-01-15' } })
        expect(evaluateFilter(note, 'due before "2026-01-20"')).toBe(true)
      })

      it('should not match when date is equal', () => {
        const note = createMockNote({ properties: { due: '2026-01-20' } })
        expect(evaluateFilter(note, 'due before "2026-01-20"')).toBe(false)
      })

      it('should not match when date is after', () => {
        const note = createMockNote({ properties: { due: '2026-01-25' } })
        expect(evaluateFilter(note, 'due before "2026-01-20"')).toBe(false)
      })
    })

    describe('after', () => {
      it('should match when date is after', () => {
        const note = createMockNote({ properties: { due: '2026-01-25' } })
        expect(evaluateFilter(note, 'due after "2026-01-20"')).toBe(true)
      })

      it('should not match when date is equal', () => {
        const note = createMockNote({ properties: { due: '2026-01-20' } })
        expect(evaluateFilter(note, 'due after "2026-01-20"')).toBe(false)
      })

      it('should not match when date is before', () => {
        const note = createMockNote({ properties: { due: '2026-01-15' } })
        expect(evaluateFilter(note, 'due after "2026-01-20"')).toBe(false)
      })
    })

    describe('built-in date properties', () => {
      it('should compare created date', () => {
        const note = createMockNote({ created: '2026-01-01T00:00:00Z' })
        expect(evaluateFilter(note, 'created before "2026-06-01"')).toBe(true)
      })

      it('should compare modified date', () => {
        const note = createMockNote({ modified: '2026-01-14T12:00:00Z' })
        expect(evaluateFilter(note, 'modified after "2026-01-01"')).toBe(true)
      })
    })

    describe('isEmpty and isNotEmpty', () => {
      it('should match empty date', () => {
        const note = createMockNote({ properties: { due: null } })
        expect(evaluateFilter(note, 'due isEmpty')).toBe(true)
      })

      it('should match non-empty date', () => {
        const note = createMockNote({ properties: { due: '2026-01-20' } })
        expect(evaluateFilter(note, 'due isNotEmpty')).toBe(true)
      })
    })
  })

  // ==========================================================================
  // T046: CHECKBOX OPERATORS
  // ==========================================================================

  describe('Checkbox Operators (T046)', () => {
    describe('isChecked', () => {
      it('should match true values', () => {
        const note = createMockNote({ properties: { completed: true } })
        expect(evaluateFilter(note, 'completed isChecked')).toBe(true)
      })

      it('should not match false values', () => {
        const note = createMockNote({ properties: { completed: false } })
        expect(evaluateFilter(note, 'completed isChecked')).toBe(false)
      })

      it('should not match null values', () => {
        const note = createMockNote({ properties: { completed: null } })
        expect(evaluateFilter(note, 'completed isChecked')).toBe(false)
      })

      it('should not match undefined values', () => {
        const note = createMockNote({ properties: { completed: undefined } })
        expect(evaluateFilter(note, 'completed isChecked')).toBe(false)
      })
    })

    describe('isUnchecked', () => {
      it('should match false values', () => {
        const note = createMockNote({ properties: { completed: false } })
        expect(evaluateFilter(note, 'completed isUnchecked')).toBe(true)
      })

      it('should match null values', () => {
        const note = createMockNote({ properties: { completed: null } })
        expect(evaluateFilter(note, 'completed isUnchecked')).toBe(true)
      })

      it('should match undefined values', () => {
        const note = createMockNote({ properties: { completed: undefined } })
        expect(evaluateFilter(note, 'completed isUnchecked')).toBe(true)
      })

      it('should not match true values', () => {
        const note = createMockNote({ properties: { completed: true } })
        expect(evaluateFilter(note, 'completed isUnchecked')).toBe(false)
      })
    })
  })

  // ==========================================================================
  // T047: SELECT OPERATORS
  // ==========================================================================

  describe('Select Operators (T047)', () => {
    describe('equality (==)', () => {
      it('should match exact select value', () => {
        const note = createMockNote({ properties: { status: 'active' } })
        expect(evaluateFilter(note, 'status == "active"')).toBe(true)
      })

      it('should be case-insensitive', () => {
        const note = createMockNote({ properties: { status: 'Active' } })
        expect(evaluateFilter(note, 'status == "active"')).toBe(true)
      })

      it('should not match different values', () => {
        const note = createMockNote({ properties: { status: 'active' } })
        expect(evaluateFilter(note, 'status == "completed"')).toBe(false)
      })
    })

    describe('inequality (!=)', () => {
      it('should match different values', () => {
        const note = createMockNote({ properties: { status: 'active' } })
        expect(evaluateFilter(note, 'status != "completed"')).toBe(true)
      })

      it('should not match equal values', () => {
        const note = createMockNote({ properties: { status: 'active' } })
        expect(evaluateFilter(note, 'status != "active"')).toBe(false)
      })
    })

    describe('isEmpty and isNotEmpty', () => {
      it('should match empty select', () => {
        const note = createMockNote({ properties: { status: null } })
        expect(evaluateFilter(note, 'status isEmpty')).toBe(true)
      })

      it('should match non-empty select', () => {
        const note = createMockNote({ properties: { status: 'active' } })
        expect(evaluateFilter(note, 'status isNotEmpty')).toBe(true)
      })
    })
  })

  // ==========================================================================
  // T048: ARRAY/MULTISELECT OPERATORS
  // ==========================================================================

  describe('Array/Multiselect Operators (T048)', () => {
    describe('contains', () => {
      it('should match when array contains value', () => {
        const note = createMockNote({ properties: { category: ['work', 'urgent'] } })
        expect(evaluateFilter(note, 'category contains "work"')).toBe(true)
      })

      it('should be case-insensitive', () => {
        const note = createMockNote({ properties: { category: ['Work', 'Urgent'] } })
        expect(evaluateFilter(note, 'category contains "work"')).toBe(true)
      })

      it('should not match when array does not contain value', () => {
        const note = createMockNote({ properties: { category: ['work', 'urgent'] } })
        expect(evaluateFilter(note, 'category contains "personal"')).toBe(false)
      })

      it('should work with tags built-in property', () => {
        const note = createMockNote({ tags: ['tag1', 'tag2'] })
        expect(evaluateFilter(note, 'tags contains "tag1"')).toBe(true)
        expect(evaluateFilter(note, 'tags contains "tag3"')).toBe(false)
      })
    })

    describe('notContains', () => {
      it('should match when array does not contain value', () => {
        const note = createMockNote({ properties: { category: ['work', 'urgent'] } })
        expect(evaluateFilter(note, 'category notContains "personal"')).toBe(true)
      })

      it('should not match when array contains value', () => {
        const note = createMockNote({ properties: { category: ['work', 'urgent'] } })
        expect(evaluateFilter(note, 'category notContains "work"')).toBe(false)
      })
    })

    describe('isEmpty and isNotEmpty', () => {
      it('should match empty array', () => {
        const note = createMockNote({ properties: { category: [] } })
        expect(evaluateFilter(note, 'category isEmpty')).toBe(true)
      })

      it('should not match non-empty array', () => {
        const note = createMockNote({ properties: { category: ['work'] } })
        expect(evaluateFilter(note, 'category isEmpty')).toBe(false)
      })

      it('should match non-empty array with isNotEmpty', () => {
        const note = createMockNote({ properties: { category: ['work'] } })
        expect(evaluateFilter(note, 'category isNotEmpty')).toBe(true)
      })
    })
  })

  // ==========================================================================
  // T049: AND LOGIC
  // ==========================================================================

  describe('AND Logic (T049)', () => {
    it('should match when all conditions are true', () => {
      const note = createMockNote({
        title: 'Project Alpha',
        properties: { status: 'active', priority: 3 }
      })
      const filter: FilterExpression = {
        and: ['status == "active"', 'priority >= 3']
      }
      expect(evaluateFilter(note, filter)).toBe(true)
    })

    it('should not match when any condition is false', () => {
      const note = createMockNote({
        properties: { status: 'active', priority: 1 }
      })
      const filter: FilterExpression = {
        and: ['status == "active"', 'priority >= 3']
      }
      expect(evaluateFilter(note, filter)).toBe(false)
    })

    it('should not match when all conditions are false', () => {
      const note = createMockNote({
        properties: { status: 'completed', priority: 1 }
      })
      const filter: FilterExpression = {
        and: ['status == "active"', 'priority >= 3']
      }
      expect(evaluateFilter(note, filter)).toBe(false)
    })

    it('should handle multiple conditions', () => {
      const note = createMockNote({
        title: 'Test',
        properties: { status: 'active', priority: 5, completed: false }
      })
      const filter: FilterExpression = {
        and: ['status == "active"', 'priority >= 3', 'completed isUnchecked']
      }
      expect(evaluateFilter(note, filter)).toBe(true)
    })

    it('should handle empty AND array (matches all)', () => {
      const note = createMockNote()
      const filter: FilterExpression = { and: [] }
      expect(evaluateFilter(note, filter)).toBe(true)
    })
  })

  // ==========================================================================
  // T050: OR LOGIC
  // ==========================================================================

  describe('OR Logic (T050)', () => {
    it('should match when any condition is true', () => {
      const note = createMockNote({
        properties: { status: 'active', priority: 1 }
      })
      const filter: FilterExpression = {
        or: ['status == "active"', 'priority >= 3']
      }
      expect(evaluateFilter(note, filter)).toBe(true)
    })

    it('should match when all conditions are true', () => {
      const note = createMockNote({
        properties: { status: 'active', priority: 5 }
      })
      const filter: FilterExpression = {
        or: ['status == "active"', 'priority >= 3']
      }
      expect(evaluateFilter(note, filter)).toBe(true)
    })

    it('should not match when all conditions are false', () => {
      const note = createMockNote({
        properties: { status: 'completed', priority: 1 }
      })
      const filter: FilterExpression = {
        or: ['status == "active"', 'priority >= 3']
      }
      expect(evaluateFilter(note, filter)).toBe(false)
    })

    it('should handle multiple conditions', () => {
      const note = createMockNote({
        properties: { status: 'pending', priority: 1, completed: true }
      })
      const filter: FilterExpression = {
        or: ['status == "active"', 'priority >= 3', 'completed isChecked']
      }
      expect(evaluateFilter(note, filter)).toBe(true)
    })

    it('should handle empty OR array (matches none)', () => {
      const note = createMockNote()
      const filter: FilterExpression = { or: [] }
      expect(evaluateFilter(note, filter)).toBe(false)
    })
  })

  // ==========================================================================
  // T051: NOT LOGIC
  // ==========================================================================

  describe('NOT Logic (T051)', () => {
    it('should negate true condition', () => {
      const note = createMockNote({ properties: { status: 'active' } })
      const filter: FilterExpression = {
        not: 'status == "active"'
      }
      expect(evaluateFilter(note, filter)).toBe(false)
    })

    it('should negate false condition', () => {
      const note = createMockNote({ properties: { status: 'completed' } })
      const filter: FilterExpression = {
        not: 'status == "active"'
      }
      expect(evaluateFilter(note, filter)).toBe(true)
    })

    it('should negate AND group', () => {
      const note = createMockNote({
        properties: { status: 'active', priority: 5 }
      })
      const filter: FilterExpression = {
        not: { and: ['status == "active"', 'priority >= 3'] }
      }
      expect(evaluateFilter(note, filter)).toBe(false)
    })

    it('should negate OR group', () => {
      const note = createMockNote({
        properties: { status: 'completed', priority: 1 }
      })
      const filter: FilterExpression = {
        not: { or: ['status == "active"', 'priority >= 3'] }
      }
      expect(evaluateFilter(note, filter)).toBe(true)
    })
  })

  // ==========================================================================
  // T052: NESTED EXPRESSIONS
  // ==========================================================================

  describe('Nested Expressions (T052)', () => {
    it('should handle AND within OR', () => {
      const note = createMockNote({
        properties: { status: 'active', priority: 5, completed: false }
      })
      const filter: FilterExpression = {
        or: [{ and: ['status == "active"', 'priority >= 3'] }, 'completed isChecked']
      }
      expect(evaluateFilter(note, filter)).toBe(true)
    })

    it('should handle OR within AND', () => {
      const note = createMockNote({
        properties: { status: 'active', priority: 1, completed: false }
      })
      const filter: FilterExpression = {
        and: [{ or: ['status == "active"', 'status == "pending"'] }, 'completed isUnchecked']
      }
      expect(evaluateFilter(note, filter)).toBe(true)
    })

    it('should handle NOT within AND', () => {
      const note = createMockNote({
        properties: { status: 'active', archived: false }
      })
      const filter: FilterExpression = {
        and: ['status == "active"', { not: 'archived isChecked' }]
      }
      expect(evaluateFilter(note, filter)).toBe(true)
    })

    it('should handle deep nesting', () => {
      const note = createMockNote({
        properties: { status: 'active', priority: 5, completed: false, archived: false }
      })
      const filter: FilterExpression = {
        and: [
          {
            or: [{ and: ['status == "active"', 'priority >= 3'] }, 'completed isChecked']
          },
          { not: 'archived isChecked' }
        ]
      }
      expect(evaluateFilter(note, filter)).toBe(true)
    })

    it('should handle triple nesting', () => {
      const note = createMockNote({
        properties: { a: true, b: true, c: true }
      })
      const filter: FilterExpression = {
        and: [
          {
            or: [
              {
                and: ['a isChecked', 'b isChecked']
              },
              'c isChecked'
            ]
          }
        ]
      }
      expect(evaluateFilter(note, filter)).toBe(true)
    })
  })

  // ==========================================================================
  // T053: parseExpression()
  // ==========================================================================

  describe('parseExpression (T053)', () => {
    describe('basic parsing', () => {
      it('should parse equality with quoted string', () => {
        const result = parseExpression('status == "active"')
        expect(result).toEqual({
          property: 'status',
          operator: '==',
          value: 'active'
        })
      })

      it('should parse equality with single quotes', () => {
        const result = parseExpression("status == 'active'")
        expect(result).toEqual({
          property: 'status',
          operator: '==',
          value: 'active'
        })
      })

      it('should parse equality with unquoted string', () => {
        const result = parseExpression('status == active')
        expect(result).toEqual({
          property: 'status',
          operator: '==',
          value: 'active'
        })
      })

      it('should parse with number value', () => {
        const result = parseExpression('priority == 5')
        expect(result).toEqual({
          property: 'priority',
          operator: '==',
          value: 5
        })
      })

      it('should parse boolean true', () => {
        const result = parseExpression('completed == true')
        expect(result).toEqual({
          property: 'completed',
          operator: '==',
          value: true
        })
      })

      it('should parse boolean false', () => {
        const result = parseExpression('completed == false')
        expect(result).toEqual({
          property: 'completed',
          operator: '==',
          value: false
        })
      })
    })

    describe('operators', () => {
      it('should parse != operator', () => {
        const result = parseExpression('status != "done"')
        expect(result?.operator).toBe('!=')
      })

      it('should parse >= operator', () => {
        const result = parseExpression('priority >= 3')
        expect(result?.operator).toBe('>=')
        expect(result?.value).toBe(3)
      })

      it('should parse <= operator', () => {
        const result = parseExpression('priority <= 3')
        expect(result?.operator).toBe('<=')
      })

      it('should parse > operator', () => {
        const result = parseExpression('priority > 3')
        expect(result?.operator).toBe('>')
      })

      it('should parse < operator', () => {
        const result = parseExpression('priority < 3')
        expect(result?.operator).toBe('<')
      })

      it('should parse contains operator', () => {
        const result = parseExpression('title contains "test"')
        expect(result?.operator).toBe('contains')
        expect(result?.value).toBe('test')
      })

      it('should parse notContains operator', () => {
        const result = parseExpression('title notContains "draft"')
        expect(result?.operator).toBe('notContains')
      })

      it('should parse startsWith operator', () => {
        const result = parseExpression('title startsWith "Project"')
        expect(result?.operator).toBe('startsWith')
      })

      it('should parse endsWith operator', () => {
        const result = parseExpression('title endsWith "v2"')
        expect(result?.operator).toBe('endsWith')
      })

      it('should parse before operator', () => {
        const result = parseExpression('due before "2026-01-20"')
        expect(result?.operator).toBe('before')
      })

      it('should parse after operator', () => {
        const result = parseExpression('due after "2026-01-01"')
        expect(result?.operator).toBe('after')
      })
    })

    describe('no-value operators', () => {
      it('should parse isEmpty operator', () => {
        const result = parseExpression('status isEmpty')
        expect(result).toEqual({
          property: 'status',
          operator: 'isEmpty',
          value: null
        })
      })

      it('should parse isNotEmpty operator', () => {
        const result = parseExpression('status isNotEmpty')
        expect(result).toEqual({
          property: 'status',
          operator: 'isNotEmpty',
          value: null
        })
      })

      it('should parse isChecked operator', () => {
        const result = parseExpression('completed isChecked')
        expect(result).toEqual({
          property: 'completed',
          operator: 'isChecked',
          value: null
        })
      })

      it('should parse isUnchecked operator', () => {
        const result = parseExpression('completed isUnchecked')
        expect(result).toEqual({
          property: 'completed',
          operator: 'isUnchecked',
          value: null
        })
      })
    })

    describe('edge cases', () => {
      it('should return null for empty string', () => {
        expect(parseExpression('')).toBeNull()
      })

      it('should return null for null input', () => {
        expect(parseExpression(null as any)).toBeNull()
      })

      it('should return null for invalid expression', () => {
        expect(parseExpression('just some text')).toBeNull()
      })

      it('should handle property names with underscores', () => {
        const result = parseExpression('my_property == "value"')
        expect(result?.property).toBe('my_property')
      })

      it('should handle property names with dots', () => {
        const result = parseExpression('obj.prop == "value"')
        expect(result?.property).toBe('obj.prop')
      })
    })
  })

  // ==========================================================================
  // T054: serializeCondition()
  // ==========================================================================

  describe('serializeCondition (T054)', () => {
    it('should serialize string value with quotes', () => {
      const condition: ParsedCondition = {
        property: 'status',
        operator: '==',
        value: 'active'
      }
      expect(serializeCondition(condition)).toBe('status == "active"')
    })

    it('should serialize number value without quotes', () => {
      const condition: ParsedCondition = {
        property: 'priority',
        operator: '>=',
        value: 5
      }
      expect(serializeCondition(condition)).toBe('priority >= 5')
    })

    it('should serialize boolean value without quotes', () => {
      const condition: ParsedCondition = {
        property: 'completed',
        operator: '==',
        value: true
      }
      expect(serializeCondition(condition)).toBe('completed == true')
    })

    it('should serialize null value as empty string', () => {
      const condition: ParsedCondition = {
        property: 'status',
        operator: '==',
        value: null
      }
      expect(serializeCondition(condition)).toBe('status == ""')
    })

    it('should serialize isEmpty without value', () => {
      const condition: ParsedCondition = {
        property: 'status',
        operator: 'isEmpty',
        value: null
      }
      expect(serializeCondition(condition)).toBe('status isEmpty')
    })

    it('should serialize isNotEmpty without value', () => {
      const condition: ParsedCondition = {
        property: 'status',
        operator: 'isNotEmpty',
        value: null
      }
      expect(serializeCondition(condition)).toBe('status isNotEmpty')
    })

    it('should serialize isChecked without value', () => {
      const condition: ParsedCondition = {
        property: 'completed',
        operator: 'isChecked',
        value: null
      }
      expect(serializeCondition(condition)).toBe('completed isChecked')
    })

    it('should serialize isUnchecked without value', () => {
      const condition: ParsedCondition = {
        property: 'completed',
        operator: 'isUnchecked',
        value: null
      }
      expect(serializeCondition(condition)).toBe('completed isUnchecked')
    })

    it('should handle various operators', () => {
      expect(serializeCondition({ property: 'p', operator: '!=', value: 'x' })).toBe('p != "x"')
      expect(serializeCondition({ property: 'p', operator: '>', value: 5 })).toBe('p > 5')
      expect(serializeCondition({ property: 'p', operator: '<', value: 5 })).toBe('p < 5')
      expect(serializeCondition({ property: 'p', operator: 'contains', value: 'x' })).toBe(
        'p contains "x"'
      )
      expect(serializeCondition({ property: 'p', operator: 'startsWith', value: 'x' })).toBe(
        'p startsWith "x"'
      )
    })
  })

  // ==========================================================================
  // T055: UTILITY FUNCTIONS
  // ==========================================================================

  describe('Utility Functions (T055)', () => {
    describe('getOperatorsForType', () => {
      it('should return text operators', () => {
        const ops = getOperatorsForType('text')
        expect(ops.map((o) => o.value)).toContain('==')
        expect(ops.map((o) => o.value)).toContain('contains')
        expect(ops.map((o) => o.value)).toContain('startsWith')
        expect(ops.map((o) => o.value)).toContain('isEmpty')
      })

      it('should return number operators', () => {
        const ops = getOperatorsForType('number')
        expect(ops.map((o) => o.value)).toContain('==')
        expect(ops.map((o) => o.value)).toContain('>')
        expect(ops.map((o) => o.value)).toContain('>=')
        expect(ops.map((o) => o.value)).toContain('<')
        expect(ops.map((o) => o.value)).toContain('<=')
      })

      it('should return date operators', () => {
        const ops = getOperatorsForType('date')
        expect(ops.map((o) => o.value)).toContain('before')
        expect(ops.map((o) => o.value)).toContain('after')
        expect(ops.map((o) => o.value)).toContain('isEmpty')
      })

      it('should return checkbox operators', () => {
        const ops = getOperatorsForType('checkbox')
        expect(ops.map((o) => o.value)).toContain('isChecked')
        expect(ops.map((o) => o.value)).toContain('isUnchecked')
        expect(ops).toHaveLength(2)
      })

      it('should return select operators', () => {
        const ops = getOperatorsForType('select')
        expect(ops.map((o) => o.value)).toContain('==')
        expect(ops.map((o) => o.value)).toContain('!=')
        expect(ops.map((o) => o.value)).toContain('isEmpty')
      })

      it('should return multiselect operators', () => {
        const ops = getOperatorsForType('multiselect')
        expect(ops.map((o) => o.value)).toContain('contains')
        expect(ops.map((o) => o.value)).toContain('notContains')
        expect(ops.map((o) => o.value)).toContain('isEmpty')
      })

      it('should return url operators', () => {
        const ops = getOperatorsForType('url')
        expect(ops.map((o) => o.value)).toContain('==')
        expect(ops.map((o) => o.value)).toContain('contains')
        expect(ops.map((o) => o.value)).toContain('isEmpty')
      })

      it('should return rating operators', () => {
        const ops = getOperatorsForType('rating')
        expect(ops.map((o) => o.value)).toContain('==')
        expect(ops.map((o) => o.value)).toContain('>=')
        expect(ops.map((o) => o.value)).toContain('<=')
      })

      it('should fallback to text operators for unknown type', () => {
        const ops = getOperatorsForType('unknown' as PropertyType)
        expect(ops.map((o) => o.value)).toContain('contains')
      })
    })

    describe('getDefaultOperator', () => {
      it('should return isChecked for checkbox', () => {
        expect(getDefaultOperator('checkbox')).toBe('isChecked')
      })

      it('should return contains for multiselect', () => {
        expect(getDefaultOperator('multiselect')).toBe('contains')
      })

      it('should return == for other types', () => {
        expect(getDefaultOperator('text')).toBe('==')
        expect(getDefaultOperator('number')).toBe('==')
        expect(getDefaultOperator('date')).toBe('==')
        expect(getDefaultOperator('select')).toBe('==')
        expect(getDefaultOperator('url')).toBe('==')
        expect(getDefaultOperator('rating')).toBe('==')
      })
    })

    describe('countFilterConditions', () => {
      it('should return 0 for undefined', () => {
        expect(countFilterConditions(undefined)).toBe(0)
      })

      it('should return 0 for null', () => {
        expect(countFilterConditions(null as any)).toBe(0)
      })

      it('should return 1 for simple expression', () => {
        expect(countFilterConditions('status == "active"')).toBe(1)
      })

      it('should count AND conditions', () => {
        expect(countFilterConditions({ and: ['a == 1', 'b == 2'] })).toBe(2)
      })

      it('should count OR conditions', () => {
        expect(countFilterConditions({ or: ['a == 1', 'b == 2', 'c == 3'] })).toBe(3)
      })

      it('should count NOT condition', () => {
        expect(countFilterConditions({ not: 'a == 1' })).toBe(1)
      })

      it('should count nested conditions', () => {
        const filter: FilterExpression = {
          and: [{ or: ['a == 1', 'b == 2'] }, 'c == 3']
        }
        expect(countFilterConditions(filter)).toBe(3)
      })

      it('should count deeply nested conditions', () => {
        const filter: FilterExpression = {
          and: [{ or: [{ and: ['a == 1', 'b == 2'] }, 'c == 3'] }, { not: 'd == 4' }]
        }
        expect(countFilterConditions(filter)).toBe(4)
      })
    })

    describe('isFilterEmpty', () => {
      it('should return true for undefined', () => {
        expect(isFilterEmpty(undefined)).toBe(true)
      })

      it('should return false for simple expression', () => {
        expect(isFilterEmpty('status == "active"')).toBe(false)
      })

      it('should return true for empty AND', () => {
        expect(isFilterEmpty({ and: [] })).toBe(true)
      })

      it('should return true for empty OR', () => {
        expect(isFilterEmpty({ or: [] })).toBe(true)
      })

      it('should return false for non-empty filter', () => {
        expect(isFilterEmpty({ and: ['a == 1'] })).toBe(false)
      })
    })
  })

  // ==========================================================================
  // T056: FILTER BUILDERS
  // ==========================================================================

  describe('Filter Builders (T056)', () => {
    describe('createSimpleFilter', () => {
      it('should create filter with string value', () => {
        const result = createSimpleFilter('status', '==', 'active')
        expect(result).toBe('status == "active"')
      })

      it('should create filter with number value', () => {
        const result = createSimpleFilter('priority', '>=', 5)
        expect(result).toBe('priority >= 5')
      })

      it('should create filter with no-value operator', () => {
        const result = createSimpleFilter('status', 'isEmpty', null)
        expect(result).toBe('status isEmpty')
      })
    })

    describe('combineFiltersAnd', () => {
      it('should return undefined for empty array', () => {
        expect(combineFiltersAnd([])).toBeUndefined()
      })

      it('should return single filter as-is', () => {
        expect(combineFiltersAnd(['a == 1'])).toBe('a == 1')
      })

      it('should combine multiple filters with AND', () => {
        const result = combineFiltersAnd(['a == 1', 'b == 2'])
        expect(result).toEqual({ and: ['a == 1', 'b == 2'] })
      })

      it('should filter out empty filters', () => {
        const result = combineFiltersAnd(['a == 1', { and: [] }, 'b == 2'])
        expect(result).toEqual({ and: ['a == 1', 'b == 2'] })
      })

      it('should return single filter if others are empty', () => {
        const result = combineFiltersAnd(['a == 1', { and: [] }])
        expect(result).toBe('a == 1')
      })
    })

    describe('combineFiltersOr', () => {
      it('should return undefined for empty array', () => {
        expect(combineFiltersOr([])).toBeUndefined()
      })

      it('should return single filter as-is', () => {
        expect(combineFiltersOr(['a == 1'])).toBe('a == 1')
      })

      it('should combine multiple filters with OR', () => {
        const result = combineFiltersOr(['a == 1', 'b == 2'])
        expect(result).toEqual({ or: ['a == 1', 'b == 2'] })
      })

      it('should filter out empty filters', () => {
        const result = combineFiltersOr(['a == 1', { or: [] }, 'b == 2'])
        expect(result).toEqual({ or: ['a == 1', 'b == 2'] })
      })
    })
  })

  // ==========================================================================
  // ADDITIONAL EDGE CASES
  // ==========================================================================

  describe('Edge Cases', () => {
    describe('null/undefined filter', () => {
      it('should match all notes when filter is null', () => {
        const note = createMockNote()
        expect(evaluateFilter(note, null as any)).toBe(true)
      })

      it('should match all notes when filter is undefined', () => {
        const note = createMockNote()
        expect(evaluateFilter(note, undefined as any)).toBe(true)
      })
    })

    describe('invalid filter', () => {
      it('should match all for unparseable expression', () => {
        const note = createMockNote()
        expect(evaluateFilter(note, 'gibberish')).toBe(true)
      })
    })

    describe('built-in properties', () => {
      it('should access title property', () => {
        const note = createMockNote({ title: 'My Title' })
        expect(evaluateFilter(note, 'title == "My Title"')).toBe(true)
      })

      it('should access folder property', () => {
        const note = createMockNote({ folder: 'projects' })
        expect(evaluateFilter(note, 'folder == "projects"')).toBe(true)
      })

      it('should access path property', () => {
        const note = createMockNote({ path: '/notes/test.md' })
        expect(evaluateFilter(note, 'path contains "test"')).toBe(true)
      })

      it('should access emoji property', () => {
        const note = createMockNote({ emoji: '📝' })
        expect(evaluateFilter(note, 'emoji isNotEmpty')).toBe(true)
      })

      it('should access emoji when null', () => {
        const note = createMockNote({ emoji: null })
        expect(evaluateFilter(note, 'emoji isEmpty')).toBe(true)
      })
    })
  })
})
