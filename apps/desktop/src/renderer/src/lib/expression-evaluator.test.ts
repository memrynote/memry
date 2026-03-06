/**
 * Expression Evaluator Tests
 *
 * Comprehensive tests for the formula expression evaluator.
 * Tests cover all built-in functions, operators, and variable resolution.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  evaluateFormula,
  evaluateFormulaWithContext,
  evaluateAST,
  getBuiltInFunctions,
  isBuiltInFunction,
  clearExpressionCache,
  type FormulaContext
} from './expression-evaluator'
import type { NoteWithProperties } from '@memry/contracts/folder-view-api'

// ============================================================================
// Mock Note Factory
// ============================================================================

const createMockNote = (overrides?: Partial<NoteWithProperties>): NoteWithProperties => {
  const defaultProperties = {
    status: 'active',
    priority: 3,
    completed: false,
    due: '2026-01-20',
    price: 25,
    quantity: 4,
    name: 'Test',
    rating: 4
  }

  return {
    id: 'note-1',
    path: '/notes/test.md',
    title: 'Test Note',
    emoji: '📝',
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
// Formula Evaluation & Cache Tests (T058)
// ============================================================================

describe('Formula Evaluation & Cache', () => {
  beforeEach(() => {
    clearExpressionCache()
  })

  describe('evaluateFormula', () => {
    it('should evaluate simple expressions', () => {
      const note = createMockNote()
      expect(evaluateFormula('1 + 2', note)).toBe(3)
    })

    it('should evaluate property references', () => {
      const note = createMockNote()
      expect(evaluateFormula('priority', note)).toBe(3)
    })

    it('should evaluate arithmetic with properties', () => {
      const note = createMockNote()
      expect(evaluateFormula('price * quantity', note)).toBe(100)
    })

    it('should return null on parse error', () => {
      const note = createMockNote()
      expect(evaluateFormula('invalid @@@ syntax', note)).toBe(null)
    })

    it('should handle string literals', () => {
      const note = createMockNote()
      expect(evaluateFormula('"hello"', note)).toBe('hello')
    })

    it('should handle boolean literals', () => {
      const note = createMockNote()
      expect(evaluateFormula('true', note)).toBe(true)
      expect(evaluateFormula('false', note)).toBe(false)
    })

    it('should handle null literal', () => {
      const note = createMockNote()
      expect(evaluateFormula('null', note)).toBe(null)
    })
  })

  describe('evaluateFormulaWithContext', () => {
    it('should evaluate with FormulaContext', () => {
      const note = createMockNote()
      const context: FormulaContext = { note }
      expect(evaluateFormulaWithContext('price + 10', context)).toBe(35)
    })

    it('should return null on error', () => {
      const note = createMockNote()
      const context: FormulaContext = { note }
      expect(evaluateFormulaWithContext('bad syntax !!!', context)).toBe(null)
    })
  })

  describe('Expression Cache', () => {
    it('should cache parsed expressions', () => {
      const note = createMockNote()
      // First call parses, second uses cache
      expect(evaluateFormula('1 + 1', note)).toBe(2)
      expect(evaluateFormula('1 + 1', note)).toBe(2)
    })

    it('should clear cache with clearExpressionCache', () => {
      const note = createMockNote()
      evaluateFormula('1 + 1', note)
      clearExpressionCache()
      // After clear, should still work (reparsed)
      expect(evaluateFormula('1 + 1', note)).toBe(2)
    })
  })

  describe('getBuiltInFunctions', () => {
    it('should return sorted list of function names', () => {
      const functions = getBuiltInFunctions()
      expect(functions).toContain('today')
      expect(functions).toContain('now')
      expect(functions).toContain('if')
      expect(functions).toContain('concat')
      expect(functions).toContain('sum')
      // Should be sorted
      expect(functions).toEqual([...functions].sort())
    })
  })

  describe('isBuiltInFunction', () => {
    it('should return true for built-in functions', () => {
      expect(isBuiltInFunction('today')).toBe(true)
      expect(isBuiltInFunction('concat')).toBe(true)
      expect(isBuiltInFunction('sum')).toBe(true)
    })

    it('should return false for unknown functions', () => {
      expect(isBuiltInFunction('notAFunction')).toBe(false)
      expect(isBuiltInFunction('xyz')).toBe(false)
    })
  })
})

// ============================================================================
// Variable Resolution Tests (T059)
// ============================================================================

describe('Variable Resolution', () => {
  describe('Note Properties', () => {
    it('should resolve custom property', () => {
      const note = createMockNote({ properties: { customField: 'custom value' } })
      expect(evaluateFormula('customField', note)).toBe('custom value')
    })

    it('should resolve numeric property', () => {
      const note = createMockNote()
      expect(evaluateFormula('priority', note)).toBe(3)
    })

    it('should resolve boolean property', () => {
      const note = createMockNote()
      expect(evaluateFormula('completed', note)).toBe(false)
    })

    it('should resolve string property', () => {
      const note = createMockNote()
      expect(evaluateFormula('status', note)).toBe('active')
    })
  })

  describe('Built-in Note Fields', () => {
    it('should resolve title', () => {
      const note = createMockNote()
      expect(evaluateFormula('title', note)).toBe('Test Note')
    })

    it('should resolve path', () => {
      const note = createMockNote()
      expect(evaluateFormula('path', note)).toBe('/notes/test.md')
    })

    it('should resolve folder', () => {
      const note = createMockNote()
      expect(evaluateFormula('folder', note)).toBe('notes')
    })

    it('should resolve tags', () => {
      const note = createMockNote()
      expect(evaluateFormula('tags', note)).toEqual(['tag1', 'tag2'])
    })

    it('should resolve created', () => {
      const note = createMockNote()
      expect(evaluateFormula('created', note)).toBe('2026-01-01T00:00:00Z')
    })

    it('should resolve modified', () => {
      const note = createMockNote()
      expect(evaluateFormula('modified', note)).toBe('2026-01-14T12:00:00Z')
    })

    it('should resolve wordCount', () => {
      const note = createMockNote()
      expect(evaluateFormula('wordCount', note)).toBe(100)
    })

    it('should resolve emoji', () => {
      const note = createMockNote()
      expect(evaluateFormula('emoji', note)).toBe('📝')
    })

    it('should resolve id', () => {
      const note = createMockNote()
      expect(evaluateFormula('id', note)).toBe('note-1')
    })
  })

  describe('Undefined Properties', () => {
    it('should return undefined for non-existent property', () => {
      const note = createMockNote()
      expect(evaluateFormula('nonExistent', note)).toBe(undefined)
    })
  })
})

// ============================================================================
// Member Access Tests (T060)
// ============================================================================

describe('Member Access', () => {
  describe('file.* Properties', () => {
    it('should resolve file.name (filename without extension)', () => {
      const note = createMockNote({ path: '/notes/my-note.md' })
      expect(evaluateFormula('file.name', note)).toBe('my-note')
    })

    it('should resolve file.path', () => {
      const note = createMockNote()
      expect(evaluateFormula('file.path', note)).toBe('/notes/test.md')
    })

    it('should resolve file.folder', () => {
      const note = createMockNote()
      expect(evaluateFormula('file.folder', note)).toBe('notes')
    })

    it('should resolve file.created', () => {
      const note = createMockNote()
      expect(evaluateFormula('file.created', note)).toBe('2026-01-01T00:00:00Z')
    })

    it('should resolve file.modified', () => {
      const note = createMockNote()
      expect(evaluateFormula('file.modified', note)).toBe('2026-01-14T12:00:00Z')
    })

    it('should resolve file.ext', () => {
      const note = createMockNote()
      expect(evaluateFormula('file.ext', note)).toBe('.md')
    })
  })

  describe('note.* Aliases', () => {
    it('should resolve note.title', () => {
      const note = createMockNote()
      expect(evaluateFormula('note.title', note)).toBe('Test Note')
    })

    it('should resolve note.tags', () => {
      const note = createMockNote()
      expect(evaluateFormula('note.tags', note)).toEqual(['tag1', 'tag2'])
    })

    it('should resolve note.wordCount', () => {
      const note = createMockNote()
      expect(evaluateFormula('note.wordCount', note)).toBe(100)
    })

    it('should resolve note.created', () => {
      const note = createMockNote()
      expect(evaluateFormula('note.created', note)).toBe('2026-01-01T00:00:00Z')
    })

    it('should resolve note.modified', () => {
      const note = createMockNote()
      expect(evaluateFormula('note.modified', note)).toBe('2026-01-14T12:00:00Z')
    })

    it('should resolve note.folder', () => {
      const note = createMockNote()
      expect(evaluateFormula('note.folder', note)).toBe('notes')
    })

    it('should resolve note.emoji', () => {
      const note = createMockNote()
      expect(evaluateFormula('note.emoji', note)).toBe('📝')
    })
  })

  describe('Unknown Member Access', () => {
    it('should return undefined for unknown file property', () => {
      const note = createMockNote()
      expect(evaluateFormula('file.unknown', note)).toBe(undefined)
    })

    it('should return undefined for unknown note property', () => {
      const note = createMockNote()
      expect(evaluateFormula('note.unknown', note)).toBe(undefined)
    })

    it('should return undefined for unknown object', () => {
      const note = createMockNote()
      expect(evaluateFormula('unknown.property', note)).toBe(undefined)
    })
  })
})

// ============================================================================
// Date Functions Tests (T061)
// ============================================================================

describe('Date Functions', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-14T10:30:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('today()', () => {
    it('should return start of today', () => {
      const note = createMockNote()
      const result = evaluateFormula('today()', note) as Date
      expect(result).toBeInstanceOf(Date)
      expect(result.getHours()).toBe(0)
      expect(result.getMinutes()).toBe(0)
      expect(result.getSeconds()).toBe(0)
    })
  })

  describe('now()', () => {
    it('should return current time', () => {
      const note = createMockNote()
      const result = evaluateFormula('now()', note) as Date
      expect(result).toBeInstanceOf(Date)
      expect(result.getTime()).toBe(new Date('2026-01-14T10:30:00Z').getTime())
    })
  })

  describe('dateDiff()', () => {
    it('should calculate difference in days', () => {
      const note = createMockNote()
      expect(evaluateFormula('dateDiff("2026-01-20", "2026-01-14", "days")', note)).toBe(6)
    })

    it('should calculate difference in hours', () => {
      const note = createMockNote()
      expect(evaluateFormula('dateDiff("2026-01-15", "2026-01-14", "hours")', note)).toBe(24)
    })

    it('should calculate difference in weeks', () => {
      const note = createMockNote()
      expect(evaluateFormula('dateDiff("2026-01-28", "2026-01-14", "weeks")', note)).toBe(2)
    })

    it('should calculate difference in minutes', () => {
      const note = createMockNote()
      expect(
        evaluateFormula('dateDiff("2026-01-14T01:00:00", "2026-01-14T00:00:00", "minutes")', note)
      ).toBe(60)
    })

    it('should calculate difference in seconds', () => {
      const note = createMockNote()
      expect(
        evaluateFormula('dateDiff("2026-01-14T00:01:00", "2026-01-14T00:00:00", "seconds")', note)
      ).toBe(60)
    })

    it('should calculate difference in months (approximate, 30-day basis)', () => {
      const note = createMockNote()
      // 59 days / 30 = 1.96 → floors to 1
      expect(evaluateFormula('dateDiff("2026-03-14", "2026-01-14", "months")', note)).toBe(1)
      // 90 days / 30 = 3
      expect(evaluateFormula('dateDiff("2026-04-14", "2026-01-14", "months")', note)).toBe(3)
    })

    it('should calculate difference in years (approximate)', () => {
      const note = createMockNote()
      expect(evaluateFormula('dateDiff("2027-01-14", "2026-01-14", "years")', note)).toBe(1)
    })

    it('should return null for invalid dates', () => {
      const note = createMockNote()
      expect(evaluateFormula('dateDiff("invalid", "2026-01-14", "days")', note)).toBe(null)
    })

    it('should default to days if no unit specified', () => {
      const note = createMockNote()
      expect(evaluateFormula('dateDiff("2026-01-20", "2026-01-14")', note)).toBe(6)
    })

    it('should return null with insufficient arguments', () => {
      const note = createMockNote()
      expect(evaluateFormula('dateDiff("2026-01-20")', note)).toBe(null)
    })
  })

  describe('dateAdd()', () => {
    it('should add days', () => {
      const note = createMockNote()
      const result = evaluateFormula('dateAdd("2026-01-14", 5, "days")', note) as Date
      expect(result.getDate()).toBe(19)
    })

    it('should add weeks', () => {
      const note = createMockNote()
      const result = evaluateFormula('dateAdd("2026-01-14", 2, "weeks")', note) as Date
      expect(result.getDate()).toBe(28)
    })

    it('should add months', () => {
      const note = createMockNote()
      const result = evaluateFormula('dateAdd("2026-01-14", 1, "months")', note) as Date
      expect(result.getMonth()).toBe(1) // February
    })

    it('should add years', () => {
      const note = createMockNote()
      const result = evaluateFormula('dateAdd("2026-01-14", 1, "years")', note) as Date
      expect(result.getFullYear()).toBe(2027)
    })

    it('should add hours', () => {
      const note = createMockNote()
      const result = evaluateFormula('dateAdd("2026-01-14T10:00:00", 5, "hours")', note) as Date
      expect(result.getHours()).toBe(15)
    })

    it('should add minutes', () => {
      const note = createMockNote()
      const result = evaluateFormula('dateAdd("2026-01-14T10:00:00", 30, "minutes")', note) as Date
      expect(result.getMinutes()).toBe(30)
    })

    it('should default to days', () => {
      const note = createMockNote()
      const result = evaluateFormula('dateAdd("2026-01-14", 3)', note) as Date
      expect(result.getDate()).toBe(17)
    })

    it('should return null for invalid date', () => {
      const note = createMockNote()
      expect(evaluateFormula('dateAdd("invalid", 5, "days")', note)).toBe(null)
    })

    it('should return null for non-number amount', () => {
      const note = createMockNote()
      expect(evaluateFormula('dateAdd("2026-01-14", "five", "days")', note)).toBe(null)
    })
  })

  describe('formatDate()', () => {
    it('should format with default pattern', () => {
      const note = createMockNote()
      expect(evaluateFormula('formatDate("2026-01-14")', note)).toBe('2026-01-14')
    })

    it('should format with custom pattern', () => {
      const note = createMockNote()
      expect(evaluateFormula('formatDate("2026-01-14", "dd/MM/yyyy")', note)).toBe('14/01/2026')
    })

    it('should format with time components', () => {
      const note = createMockNote()
      expect(evaluateFormula('formatDate("2026-01-14T15:30:45", "HH:mm:ss")', note)).toBe(
        '15:30:45'
      )
    })

    it('should return null for invalid date', () => {
      const note = createMockNote()
      expect(evaluateFormula('formatDate("invalid")', note)).toBe(null)
    })

    it('should return null with no arguments', () => {
      const note = createMockNote()
      expect(evaluateFormula('formatDate()', note)).toBe(null)
    })
  })
})

// ============================================================================
// Conditional Functions Tests (T062)
// ============================================================================

describe('Conditional Functions', () => {
  describe('if()', () => {
    it('should return trueValue when condition is true', () => {
      const note = createMockNote()
      expect(evaluateFormula('if(true, "yes", "no")', note)).toBe('yes')
    })

    it('should return falseValue when condition is false', () => {
      const note = createMockNote()
      expect(evaluateFormula('if(false, "yes", "no")', note)).toBe('no')
    })

    it('should return null when falseValue not provided and condition false', () => {
      const note = createMockNote()
      expect(evaluateFormula('if(false, "yes")', note)).toBe(null)
    })

    it('should work with expressions as condition', () => {
      const note = createMockNote()
      expect(evaluateFormula('if(priority > 2, "high", "low")', note)).toBe('high')
    })

    it('should work with property as condition', () => {
      const note = createMockNote({ properties: { completed: true } })
      expect(evaluateFormula('if(completed, "done", "pending")', note)).toBe('done')
    })

    it('should return null with insufficient arguments', () => {
      const note = createMockNote()
      expect(evaluateFormula('if(true)', note)).toBe(null)
    })
  })

  describe('coalesce()', () => {
    it('should return first non-null value', () => {
      const note = createMockNote()
      expect(evaluateFormula('coalesce(null, "value")', note)).toBe('value')
    })

    it('should return first value if not null', () => {
      const note = createMockNote()
      expect(evaluateFormula('coalesce("first", "second")', note)).toBe('first')
    })

    it('should skip undefined values', () => {
      const note = createMockNote()
      expect(evaluateFormula('coalesce(nonExistent, "fallback")', note)).toBe('fallback')
    })

    it('should skip empty strings', () => {
      const note = createMockNote()
      expect(evaluateFormula('coalesce("", "value")', note)).toBe('value')
    })

    it('should return null if all values are null/empty', () => {
      const note = createMockNote()
      expect(evaluateFormula('coalesce(null, null)', note)).toBe(null)
    })

    it('should work with multiple values', () => {
      const note = createMockNote()
      expect(evaluateFormula('coalesce(null, "", null, "found")', note)).toBe('found')
    })
  })
})

// ============================================================================
// String Functions Tests (T063)
// ============================================================================

describe('String Functions', () => {
  describe('concat()', () => {
    it('should concatenate strings', () => {
      const note = createMockNote()
      expect(evaluateFormula('concat("hello", " ", "world")', note)).toBe('hello world')
    })

    it('should handle null values', () => {
      const note = createMockNote()
      expect(evaluateFormula('concat("hello", null, "world")', note)).toBe('helloworld')
    })

    it('should convert numbers to strings', () => {
      const note = createMockNote()
      expect(evaluateFormula('concat("value: ", 42)', note)).toBe('value: 42')
    })

    it('should work with properties', () => {
      const note = createMockNote()
      expect(evaluateFormula('concat(title, " - ", status)', note)).toBe('Test Note - active')
    })
  })

  describe('lower()', () => {
    it('should convert to lowercase', () => {
      const note = createMockNote()
      expect(evaluateFormula('lower("HELLO")', note)).toBe('hello')
    })

    it('should return null for non-string', () => {
      const note = createMockNote()
      expect(evaluateFormula('lower(123)', note)).toBe(null)
    })

    it('should return null with no arguments', () => {
      const note = createMockNote()
      expect(evaluateFormula('lower()', note)).toBe(null)
    })
  })

  describe('upper()', () => {
    it('should convert to uppercase', () => {
      const note = createMockNote()
      expect(evaluateFormula('upper("hello")', note)).toBe('HELLO')
    })

    it('should return null for non-string', () => {
      const note = createMockNote()
      expect(evaluateFormula('upper(123)', note)).toBe(null)
    })
  })

  describe('trim()', () => {
    it('should trim whitespace', () => {
      const note = createMockNote()
      expect(evaluateFormula('trim("  hello  ")', note)).toBe('hello')
    })

    it('should return null for non-string', () => {
      const note = createMockNote()
      expect(evaluateFormula('trim(123)', note)).toBe(null)
    })
  })

  describe('substring()', () => {
    it('should extract substring with start', () => {
      const note = createMockNote()
      expect(evaluateFormula('substring("hello", 1)', note)).toBe('ello')
    })

    it('should extract substring with start and end', () => {
      const note = createMockNote()
      expect(evaluateFormula('substring("hello", 1, 4)', note)).toBe('ell')
    })

    it('should return null for non-string', () => {
      const note = createMockNote()
      expect(evaluateFormula('substring(123, 1)', note)).toBe(null)
    })

    it('should return null without start index', () => {
      const note = createMockNote()
      expect(evaluateFormula('substring("hello")', note)).toBe(null)
    })
  })

  describe('replace()', () => {
    it('should replace all occurrences', () => {
      const note = createMockNote()
      expect(evaluateFormula('replace("hello hello", "hello", "hi")', note)).toBe('hi hi')
    })

    it('should handle no match', () => {
      const note = createMockNote()
      expect(evaluateFormula('replace("hello", "x", "y")', note)).toBe('hello')
    })

    it('should return null with insufficient arguments', () => {
      const note = createMockNote()
      expect(evaluateFormula('replace("hello", "l")', note)).toBe(null)
    })

    it('should return null for non-string input', () => {
      const note = createMockNote()
      expect(evaluateFormula('replace(123, "1", "2")', note)).toBe(null)
    })
  })

  describe('contains()', () => {
    it('should return true when string contains substring (case-insensitive)', () => {
      const note = createMockNote()
      expect(evaluateFormula('contains("Hello World", "world")', note)).toBe(true)
    })

    it('should return false when string does not contain substring', () => {
      const note = createMockNote()
      expect(evaluateFormula('contains("Hello", "xyz")', note)).toBe(false)
    })

    it('should work with arrays', () => {
      const note = createMockNote()
      expect(evaluateFormula('contains(tags, "tag1")', note)).toBe(true)
    })

    it('should be case-insensitive for arrays', () => {
      const note = createMockNote({ tags: ['Tag1', 'Tag2'] })
      expect(evaluateFormula('contains(tags, "tag1")', note)).toBe(true)
    })

    it('should return false with insufficient arguments', () => {
      const note = createMockNote()
      expect(evaluateFormula('contains("hello")', note)).toBe(false)
    })
  })

  describe('startsWith()', () => {
    it('should return true when string starts with prefix (case-insensitive)', () => {
      const note = createMockNote()
      expect(evaluateFormula('startsWith("Hello World", "hello")', note)).toBe(true)
    })

    it('should return false when string does not start with prefix', () => {
      const note = createMockNote()
      expect(evaluateFormula('startsWith("Hello", "World")', note)).toBe(false)
    })

    it('should return false for non-string', () => {
      const note = createMockNote()
      expect(evaluateFormula('startsWith(123, "1")', note)).toBe(false)
    })
  })

  describe('endsWith()', () => {
    it('should return true when string ends with suffix (case-insensitive)', () => {
      const note = createMockNote()
      expect(evaluateFormula('endsWith("Hello World", "WORLD")', note)).toBe(true)
    })

    it('should return false when string does not end with suffix', () => {
      const note = createMockNote()
      expect(evaluateFormula('endsWith("Hello", "x")', note)).toBe(false)
    })

    it('should return false for non-string', () => {
      const note = createMockNote()
      expect(evaluateFormula('endsWith(123, "3")', note)).toBe(false)
    })
  })

  describe('length()', () => {
    it('should return string length', () => {
      const note = createMockNote()
      expect(evaluateFormula('length("hello")', note)).toBe(5)
    })

    it('should return array length', () => {
      const note = createMockNote()
      expect(evaluateFormula('length(tags)', note)).toBe(2)
    })

    it('should return null for non-string/array', () => {
      const note = createMockNote()
      expect(evaluateFormula('length(123)', note)).toBe(null)
    })

    it('should return null with no arguments', () => {
      const note = createMockNote()
      expect(evaluateFormula('length()', note)).toBe(null)
    })
  })
})

// ============================================================================
// Number Functions Tests (T064)
// ============================================================================

describe('Number Functions', () => {
  describe('round()', () => {
    it('should round to nearest integer', () => {
      const note = createMockNote()
      expect(evaluateFormula('round(3.7)', note)).toBe(4)
      expect(evaluateFormula('round(3.2)', note)).toBe(3)
    })

    it('should round to specified decimals', () => {
      const note = createMockNote()
      expect(evaluateFormula('round(3.14159, 2)', note)).toBe(3.14)
    })

    it('should return null for non-number', () => {
      const note = createMockNote()
      expect(evaluateFormula('round("abc")', note)).toBe(null)
    })
  })

  describe('floor()', () => {
    it('should floor number', () => {
      const note = createMockNote()
      expect(evaluateFormula('floor(3.9)', note)).toBe(3)
    })

    it('should return null for non-number', () => {
      const note = createMockNote()
      expect(evaluateFormula('floor("abc")', note)).toBe(null)
    })
  })

  describe('ceil()', () => {
    it('should ceil number', () => {
      const note = createMockNote()
      expect(evaluateFormula('ceil(3.1)', note)).toBe(4)
    })

    it('should return null for non-number', () => {
      const note = createMockNote()
      expect(evaluateFormula('ceil("abc")', note)).toBe(null)
    })
  })

  describe('abs()', () => {
    it('should return absolute value', () => {
      const note = createMockNote()
      expect(evaluateFormula('abs(-5)', note)).toBe(5)
      expect(evaluateFormula('abs(5)', note)).toBe(5)
    })

    it('should return null for non-number', () => {
      const note = createMockNote()
      expect(evaluateFormula('abs("abc")', note)).toBe(null)
    })
  })

  describe('min()', () => {
    it('should return minimum value', () => {
      const note = createMockNote()
      expect(evaluateFormula('min(1, 5, 3)', note)).toBe(1)
    })

    it('should filter non-numbers', () => {
      const note = createMockNote()
      expect(evaluateFormula('min(1, "abc", 3)', note)).toBe(1)
    })

    it('should return null for no valid numbers', () => {
      const note = createMockNote()
      expect(evaluateFormula('min("abc")', note)).toBe(null)
    })
  })

  describe('max()', () => {
    it('should return maximum value', () => {
      const note = createMockNote()
      expect(evaluateFormula('max(1, 5, 3)', note)).toBe(5)
    })

    it('should filter non-numbers', () => {
      const note = createMockNote()
      expect(evaluateFormula('max(1, "abc", 10)', note)).toBe(10)
    })

    it('should return null for no valid numbers', () => {
      const note = createMockNote()
      expect(evaluateFormula('max("abc")', note)).toBe(null)
    })
  })

  describe('sum()', () => {
    it('should sum numbers', () => {
      const note = createMockNote()
      expect(evaluateFormula('sum(1, 2, 3)', note)).toBe(6)
    })

    it('should sum array elements', () => {
      const note = createMockNote({ properties: { nums: [1, 2, 3] } })
      expect(evaluateFormula('sum(nums)', note)).toBe(6)
    })

    it('should filter non-numbers', () => {
      const note = createMockNote()
      expect(evaluateFormula('sum(1, "abc", 2)', note)).toBe(3)
    })

    it('should return 0 for no arguments', () => {
      const note = createMockNote()
      expect(evaluateFormula('sum()', note)).toBe(0)
    })
  })

  describe('avg()', () => {
    it('should calculate average', () => {
      const note = createMockNote()
      expect(evaluateFormula('avg(2, 4, 6)', note)).toBe(4)
    })

    it('should average array elements', () => {
      const note = createMockNote({ properties: { nums: [10, 20, 30] } })
      expect(evaluateFormula('avg(nums)', note)).toBe(20)
    })

    it('should return null for no valid numbers', () => {
      const note = createMockNote()
      expect(evaluateFormula('avg("abc")', note)).toBe(null)
    })
  })

  describe('toFixed()', () => {
    it('should format with default 2 decimals', () => {
      const note = createMockNote()
      expect(evaluateFormula('toFixed(3.14159)', note)).toBe('3.14')
    })

    it('should format with specified decimals', () => {
      const note = createMockNote()
      expect(evaluateFormula('toFixed(3.14159, 3)', note)).toBe('3.142')
    })

    it('should return null for non-number', () => {
      const note = createMockNote()
      expect(evaluateFormula('toFixed("abc")', note)).toBe(null)
    })
  })
})

// ============================================================================
// Type Conversion Functions Tests (T065)
// ============================================================================

describe('Type Conversion Functions', () => {
  describe('number()', () => {
    it('should pass through numbers', () => {
      const note = createMockNote()
      expect(evaluateFormula('number(42)', note)).toBe(42)
    })

    it('should convert string to number', () => {
      const note = createMockNote()
      expect(evaluateFormula('number("42.5")', note)).toBe(42.5)
    })

    it('should convert true to 1', () => {
      const note = createMockNote()
      expect(evaluateFormula('number(true)', note)).toBe(1)
    })

    it('should convert false to 0', () => {
      const note = createMockNote()
      expect(evaluateFormula('number(false)', note)).toBe(0)
    })

    it('should return null for invalid string', () => {
      const note = createMockNote()
      expect(evaluateFormula('number("abc")', note)).toBe(null)
    })

    it('should return null with no arguments', () => {
      const note = createMockNote()
      expect(evaluateFormula('number()', note)).toBe(null)
    })
  })

  describe('string()', () => {
    it('should convert number to string', () => {
      const note = createMockNote()
      expect(evaluateFormula('string(42)', note)).toBe('42')
    })

    it('should convert boolean to string', () => {
      const note = createMockNote()
      expect(evaluateFormula('string(true)', note)).toBe('true')
    })

    it('should convert Date to ISO string', () => {
      const note = createMockNote()
      const result = evaluateFormula('string(now())', note)
      expect(typeof result).toBe('string')
      expect((result as string).includes('2026')).toBe(true)
    })

    it('should return null for null input', () => {
      const note = createMockNote()
      expect(evaluateFormula('string(null)', note)).toBe(null)
    })

    it('should return null with no arguments', () => {
      const note = createMockNote()
      expect(evaluateFormula('string()', note)).toBe(null)
    })
  })

  describe('boolean()', () => {
    it('should pass through booleans', () => {
      const note = createMockNote()
      expect(evaluateFormula('boolean(true)', note)).toBe(true)
      expect(evaluateFormula('boolean(false)', note)).toBe(false)
    })

    it('should convert non-zero number to true', () => {
      const note = createMockNote()
      expect(evaluateFormula('boolean(42)', note)).toBe(true)
    })

    it('should convert zero to false', () => {
      const note = createMockNote()
      expect(evaluateFormula('boolean(0)', note)).toBe(false)
    })

    it('should convert non-empty string to true', () => {
      const note = createMockNote()
      expect(evaluateFormula('boolean("hello")', note)).toBe(true)
    })

    it('should convert empty string to false', () => {
      const note = createMockNote()
      expect(evaluateFormula('boolean("")', note)).toBe(false)
    })

    it('should convert "false" string to false', () => {
      const note = createMockNote()
      expect(evaluateFormula('boolean("false")', note)).toBe(false)
    })

    it('should convert null to false', () => {
      const note = createMockNote()
      expect(evaluateFormula('boolean(null)', note)).toBe(false)
    })

    it('should return null with no arguments', () => {
      const note = createMockNote()
      expect(evaluateFormula('boolean()', note)).toBe(null)
    })
  })
})

// ============================================================================
// Array Functions Tests (T066)
// ============================================================================

describe('Array Functions', () => {
  describe('join()', () => {
    it('should join array with default separator', () => {
      const note = createMockNote()
      expect(evaluateFormula('join(tags)', note)).toBe('tag1, tag2')
    })

    it('should join array with custom separator', () => {
      const note = createMockNote()
      expect(evaluateFormula('join(tags, " | ")', note)).toBe('tag1 | tag2')
    })

    it('should return null for non-array', () => {
      const note = createMockNote()
      expect(evaluateFormula('join("hello")', note)).toBe(null)
    })

    it('should return null with no arguments', () => {
      const note = createMockNote()
      expect(evaluateFormula('join()', note)).toBe(null)
    })
  })

  describe('first()', () => {
    it('should return first element', () => {
      const note = createMockNote()
      expect(evaluateFormula('first(tags)', note)).toBe('tag1')
    })

    it('should return null for empty array', () => {
      const note = createMockNote({ tags: [] })
      expect(evaluateFormula('first(tags)', note)).toBe(null)
    })

    it('should return null for non-array', () => {
      const note = createMockNote()
      expect(evaluateFormula('first("hello")', note)).toBe(null)
    })

    it('should return null with no arguments', () => {
      const note = createMockNote()
      expect(evaluateFormula('first()', note)).toBe(null)
    })
  })

  describe('last()', () => {
    it('should return last element', () => {
      const note = createMockNote()
      expect(evaluateFormula('last(tags)', note)).toBe('tag2')
    })

    it('should return null for empty array', () => {
      const note = createMockNote({ tags: [] })
      expect(evaluateFormula('last(tags)', note)).toBe(null)
    })

    it('should return null for non-array', () => {
      const note = createMockNote()
      expect(evaluateFormula('last("hello")', note)).toBe(null)
    })

    it('should return null with no arguments', () => {
      const note = createMockNote()
      expect(evaluateFormula('last()', note)).toBe(null)
    })
  })
})

// ============================================================================
// Utility Functions Tests (T067)
// ============================================================================

describe('Utility Functions', () => {
  describe('empty()', () => {
    it('should return true for null', () => {
      const note = createMockNote()
      expect(evaluateFormula('empty(null)', note)).toBe(true)
    })

    it('should return true for undefined', () => {
      const note = createMockNote()
      expect(evaluateFormula('empty(nonExistent)', note)).toBe(true)
    })

    it('should return true for empty string', () => {
      const note = createMockNote()
      expect(evaluateFormula('empty("")', note)).toBe(true)
    })

    it('should return true for whitespace-only string', () => {
      const note = createMockNote()
      expect(evaluateFormula('empty("   ")', note)).toBe(true)
    })

    it('should return true for empty array', () => {
      const note = createMockNote({ tags: [] })
      expect(evaluateFormula('empty(tags)', note)).toBe(true)
    })

    it('should return false for non-empty string', () => {
      const note = createMockNote()
      expect(evaluateFormula('empty("hello")', note)).toBe(false)
    })

    it('should return false for non-empty array', () => {
      const note = createMockNote()
      expect(evaluateFormula('empty(tags)', note)).toBe(false)
    })

    it('should return false for numbers', () => {
      const note = createMockNote()
      expect(evaluateFormula('empty(0)', note)).toBe(false)
      expect(evaluateFormula('empty(42)', note)).toBe(false)
    })

    it('should return true with no arguments', () => {
      const note = createMockNote()
      expect(evaluateFormula('empty()', note)).toBe(true)
    })
  })

  describe('default()', () => {
    it('should return value if not empty', () => {
      const note = createMockNote()
      expect(evaluateFormula('default("hello", "fallback")', note)).toBe('hello')
    })

    it('should return default for null', () => {
      const note = createMockNote()
      expect(evaluateFormula('default(null, "fallback")', note)).toBe('fallback')
    })

    it('should return default for undefined', () => {
      const note = createMockNote()
      expect(evaluateFormula('default(nonExistent, "fallback")', note)).toBe('fallback')
    })

    it('should return default for empty string', () => {
      const note = createMockNote()
      expect(evaluateFormula('default("", "fallback")', note)).toBe('fallback')
    })

    it('should return null if only one argument', () => {
      const note = createMockNote()
      expect(evaluateFormula('default(null)', note)).toBe(null)
    })

    it('should work with properties', () => {
      const note = createMockNote()
      expect(evaluateFormula('default(status, "unknown")', note)).toBe('active')
    })
  })
})

// ============================================================================
// Binary Operators Tests (T068)
// ============================================================================

describe('Binary Operators', () => {
  describe('Arithmetic Operators', () => {
    it('should add numbers', () => {
      const note = createMockNote()
      expect(evaluateFormula('5 + 3', note)).toBe(8)
    })

    it('should subtract numbers', () => {
      const note = createMockNote()
      expect(evaluateFormula('10 - 4', note)).toBe(6)
    })

    it('should multiply numbers', () => {
      const note = createMockNote()
      expect(evaluateFormula('6 * 7', note)).toBe(42)
    })

    it('should divide numbers', () => {
      const note = createMockNote()
      expect(evaluateFormula('20 / 4', note)).toBe(5)
    })

    it('should return null for division by zero', () => {
      const note = createMockNote()
      expect(evaluateFormula('10 / 0', note)).toBe(null)
    })

    it('should calculate modulo', () => {
      const note = createMockNote()
      expect(evaluateFormula('10 % 3', note)).toBe(1)
    })

    it('should return null for modulo by zero', () => {
      const note = createMockNote()
      expect(evaluateFormula('10 % 0', note)).toBe(null)
    })

    it('should calculate power', () => {
      const note = createMockNote()
      expect(evaluateFormula('2 ** 3', note)).toBe(8)
    })

    it('should return null for non-number operands', () => {
      const note = createMockNote()
      expect(evaluateFormula('"a" - "b"', note)).toBe(null)
    })
  })

  describe('String Concatenation', () => {
    it('should concatenate strings with +', () => {
      const note = createMockNote()
      expect(evaluateFormula('"hello" + " " + "world"', note)).toBe('hello world')
    })

    it('should convert number to string when concatenating', () => {
      const note = createMockNote()
      expect(evaluateFormula('"value: " + 42', note)).toBe('value: 42')
    })

    it('should handle null in concatenation', () => {
      const note = createMockNote()
      expect(evaluateFormula('"prefix" + null', note)).toBe('prefix')
    })
  })

  describe('Comparison Operators', () => {
    it('should compare equality', () => {
      const note = createMockNote()
      expect(evaluateFormula('5 == 5', note)).toBe(true)
      expect(evaluateFormula('5 == 6', note)).toBe(false)
    })

    it('should compare inequality', () => {
      const note = createMockNote()
      expect(evaluateFormula('5 != 6', note)).toBe(true)
      expect(evaluateFormula('5 != 5', note)).toBe(false)
    })

    it('should compare less than', () => {
      const note = createMockNote()
      expect(evaluateFormula('3 < 5', note)).toBe(true)
      expect(evaluateFormula('5 < 3', note)).toBe(false)
    })

    it('should compare greater than', () => {
      const note = createMockNote()
      expect(evaluateFormula('5 > 3', note)).toBe(true)
      expect(evaluateFormula('3 > 5', note)).toBe(false)
    })

    it('should compare less than or equal', () => {
      const note = createMockNote()
      expect(evaluateFormula('3 <= 5', note)).toBe(true)
      expect(evaluateFormula('5 <= 5', note)).toBe(true)
      expect(evaluateFormula('6 <= 5', note)).toBe(false)
    })

    it('should compare greater than or equal', () => {
      const note = createMockNote()
      expect(evaluateFormula('5 >= 3', note)).toBe(true)
      expect(evaluateFormula('5 >= 5', note)).toBe(true)
      expect(evaluateFormula('3 >= 5', note)).toBe(false)
    })

    it('should compare strings', () => {
      const note = createMockNote()
      expect(evaluateFormula('"apple" < "banana"', note)).toBe(true)
      expect(evaluateFormula('"zebra" > "apple"', note)).toBe(true)
    })

    it('should compare dates', () => {
      const note = createMockNote()
      expect(evaluateFormula('"2026-01-15" > "2026-01-14"', note)).toBe(true)
      expect(evaluateFormula('"2026-01-14" < "2026-01-15"', note)).toBe(true)
    })

    it('should handle null comparisons', () => {
      const note = createMockNote()
      expect(evaluateFormula('null == null', note)).toBe(true)
      expect(evaluateFormula('null < 5', note)).toBe(true)
      expect(evaluateFormula('5 > null', note)).toBe(true)
    })
  })

  describe('Logical Operators', () => {
    it('should evaluate OR', () => {
      const note = createMockNote()
      expect(evaluateFormula('true || false', note)).toBe(true)
      expect(evaluateFormula('false || false', note)).toBe(false)
    })

    it('should evaluate AND', () => {
      const note = createMockNote()
      expect(evaluateFormula('true && true', note)).toBe(true)
      expect(evaluateFormula('true && false', note)).toBe(false)
    })

    it('should short-circuit OR', () => {
      const note = createMockNote()
      expect(evaluateFormula('true || nonExistent', note)).toBe(true)
    })

    it('should short-circuit AND', () => {
      const note = createMockNote()
      expect(evaluateFormula('false && nonExistent', note)).toBe(false)
    })
  })
})

// ============================================================================
// Unary Operators Tests (T069)
// ============================================================================

describe('Unary Operators', () => {
  describe('Logical NOT (!)', () => {
    it('should negate true', () => {
      const note = createMockNote()
      expect(evaluateFormula('!true', note)).toBe(false)
    })

    it('should negate false', () => {
      const note = createMockNote()
      expect(evaluateFormula('!false', note)).toBe(true)
    })

    it('should negate truthy values', () => {
      const note = createMockNote()
      expect(evaluateFormula('!"hello"', note)).toBe(false)
      expect(evaluateFormula('!42', note)).toBe(false)
    })

    it('should negate falsy values', () => {
      const note = createMockNote()
      expect(evaluateFormula('!null', note)).toBe(true)
      expect(evaluateFormula('!""', note)).toBe(true)
      expect(evaluateFormula('!0', note)).toBe(true)
    })

    it('should work with properties', () => {
      const note = createMockNote()
      expect(evaluateFormula('!completed', note)).toBe(true)
    })
  })

  describe('Numeric Negation (-)', () => {
    it('should negate positive number', () => {
      const note = createMockNote()
      expect(evaluateFormula('-5', note)).toBe(-5)
    })

    it('should negate negative number', () => {
      const note = createMockNote()
      expect(evaluateFormula('-(-5)', note)).toBe(5)
    })

    it('should return null for non-number', () => {
      const note = createMockNote()
      expect(evaluateFormula('-"hello"', note)).toBe(null)
    })

    it('should work with properties', () => {
      const note = createMockNote()
      expect(evaluateFormula('-priority', note)).toBe(-3)
    })
  })
})

// ============================================================================
// Conditional Expressions & Edge Cases Tests (T070)
// ============================================================================

describe('Conditional Expressions & Edge Cases', () => {
  describe('Ternary-like Expressions', () => {
    it('should evaluate conditional expression', () => {
      const note = createMockNote()
      expect(evaluateFormula('priority > 2 ? "high" : "low"', note)).toBe('high')
    })

    it('should evaluate false branch', () => {
      const note = createMockNote({ properties: { priority: 1 } })
      expect(evaluateFormula('priority > 2 ? "high" : "low"', note)).toBe('low')
    })

    it('should nest conditional expressions', () => {
      const note = createMockNote()
      expect(evaluateFormula('priority > 4 ? "urgent" : priority > 2 ? "high" : "low"', note)).toBe(
        'high'
      )
    })
  })

  describe('Nested Function Calls', () => {
    it('should handle nested function calls', () => {
      const note = createMockNote()
      expect(evaluateFormula('upper(concat("hello", " ", "world"))', note)).toBe('HELLO WORLD')
    })

    it('should handle deeply nested calls', () => {
      const note = createMockNote()
      expect(evaluateFormula('length(trim("  hello  "))', note)).toBe(5)
    })

    it('should combine date functions', () => {
      const note = createMockNote()
      const result = evaluateFormula('formatDate(dateAdd("2026-01-14", 7, "days"))', note)
      expect(result).toBe('2026-01-21')
    })
  })

  describe('Error Handling', () => {
    it('should return null for unknown function', () => {
      const note = createMockNote()
      expect(evaluateFormula('unknownFunction()', note)).toBe(null)
    })

    it('should return null for parse errors', () => {
      const note = createMockNote()
      expect(evaluateFormula('((( invalid', note)).toBe(null)
    })

    it('should handle undefined property gracefully', () => {
      const note = createMockNote()
      expect(evaluateFormula('nonExistent + 5', note)).toBe(null)
    })
  })

  describe('Complex Expressions', () => {
    it('should evaluate complex arithmetic', () => {
      const note = createMockNote()
      expect(evaluateFormula('(price * quantity) + (price * 0.1)', note)).toBe(102.5)
    })

    it('should evaluate with multiple properties', () => {
      const note = createMockNote()
      expect(evaluateFormula('if(completed, "Done", concat("Priority: ", priority))', note)).toBe(
        'Priority: 3'
      )
    })

    it('should handle mixed types in comparisons', () => {
      const note = createMockNote()
      // Numeric strings are parsed as dates (Date constructor accepts numbers)
      // So "10" and "9" are compared as timestamps (10ms vs 9ms)
      expect(evaluateFormula('"10" > "9"', note)).toBe(true)
      // Date strings should compare as dates
      expect(evaluateFormula('"2026-01-20" > "2026-01-14"', note)).toBe(true)
      // Text strings that can't be dates use string comparison
      expect(evaluateFormula('"apple" < "banana"', note)).toBe(true)
    })
  })

  describe('Property Access on Evaluated Objects', () => {
    it('should only support file.* and note.* member access', () => {
      const note = createMockNote({ properties: { data: { value: 42 } } })
      // The evaluator only supports file.* and note.* member access patterns
      // Arbitrary property.subproperty access is not supported
      expect(evaluateFormula('data.value', note)).toBe(undefined)
      // But file.* and note.* work
      expect(evaluateFormula('file.name', note)).toBe('test')
      expect(evaluateFormula('note.title', note)).toBe('Test Note')
    })

    it('should access nested object as a whole property', () => {
      const note = createMockNote({ properties: { data: { value: 42 } } })
      // Can access the nested object itself
      const result = evaluateFormula('data', note)
      expect(result).toEqual({ value: 42 })
    })
  })

  describe('Edge Cases', () => {
    it('should handle empty expression', () => {
      const note = createMockNote()
      expect(evaluateFormula('', note)).toBe(null)
    })

    it('should handle whitespace-only expression', () => {
      const note = createMockNote()
      expect(evaluateFormula('   ', note)).toBe(null)
    })

    it('should handle numeric string in date context', () => {
      const note = createMockNote()
      // Numeric timestamps should be parsed as dates
      const result = evaluateFormula('dateDiff(1767225600000, 1767139200000, "days")', note)
      expect(result).toBe(1)
    })

    it('should handle Date object in date functions', () => {
      const note = createMockNote()
      const result = evaluateFormula('dateDiff(now(), today(), "hours")', note)
      expect(typeof result).toBe('number')
    })
  })
})

// ============================================================================
// evaluateAST Tests
// ============================================================================

describe('evaluateAST', () => {
  it('should evaluate literal node', () => {
    const note = createMockNote()
    const context: FormulaContext = { note }
    const result = evaluateAST({ type: 'literal', value: 42 }, context)
    expect(result).toBe(42)
  })

  it('should evaluate identifier node', () => {
    const note = createMockNote()
    const context: FormulaContext = { note }
    const result = evaluateAST({ type: 'identifier', name: 'priority' }, context)
    expect(result).toBe(3)
  })

  it('should return null for unknown node type', () => {
    const note = createMockNote()
    const context: FormulaContext = { note }
    // @ts-expect-error Testing unknown node type
    const result = evaluateAST({ type: 'unknown' }, context)
    expect(result).toBe(null)
  })
})
