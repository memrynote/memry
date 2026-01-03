/**
 * Fuzzy Search Tests
 *
 * Tests for fuzzy search utility functions:
 * - fuzzySearch: Fuzzy matching through items with scoring
 * - highlightMatches: Highlighting matched characters in text
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { fuzzySearch, highlightMatches, type FuzzyMatch } from './fuzzy-search'

// Use fake timers for deterministic dates
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 0, 15, 14, 30))
})

afterEach(() => {
  vi.useRealTimers()
})

// Test data
interface TestItem {
  id: number
  name: string
  description: string
}

const items: TestItem[] = [
  { id: 1, name: 'Task Manager', description: 'Manage your tasks' },
  { id: 2, name: 'Note Editor', description: 'Edit notes quickly' },
  { id: 3, name: 'My Tasks', description: 'Personal task list' }
]

describe('fuzzySearch', () => {
  describe('empty query handling', () => {
    it('returns all items when query is empty string', () => {
      const result = fuzzySearch(items, '', ['name'])
      expect(result).toHaveLength(3)
      expect(result).toEqual(items)
    })

    it('returns all items when query is whitespace only', () => {
      const result = fuzzySearch(items, '   ', ['name'])
      expect(result).toHaveLength(3)
      expect(result).toEqual(items)
    })
  })

  describe('exact string matching', () => {
    it('matches exact string in name field', () => {
      const result = fuzzySearch(items, 'Task Manager', ['name'])
      expect(result).toHaveLength(1)
      expect(result[0].name).toBe('Task Manager')
    })

    it('matches exact string case-insensitively', () => {
      const result = fuzzySearch(items, 'task manager', ['name'])
      expect(result).toHaveLength(1)
      expect(result[0].name).toBe('Task Manager')
    })

    it('matches partial exact string', () => {
      const result = fuzzySearch(items, 'Note', ['name'])
      expect(result).toHaveLength(1)
      expect(result[0].name).toBe('Note Editor')
    })
  })

  describe('non-consecutive character matching', () => {
    it('matches non-consecutive characters "tsk" in "task"', () => {
      const result = fuzzySearch(items, 'tsk', ['name'])
      expect(result.length).toBeGreaterThan(0)
      // Should match items containing "task"
      const names = result.map((r) => r.name)
      expect(names.some((n) => n.toLowerCase().includes('task'))).toBe(true)
    })

    it('matches "tm" in "Task Manager"', () => {
      const result = fuzzySearch(items, 'tm', ['name'])
      expect(result.length).toBeGreaterThan(0)
      expect(result[0].name).toBe('Task Manager')
    })

    it('matches "ne" in "Note Editor"', () => {
      const result = fuzzySearch(items, 'ne', ['name'])
      expect(result.length).toBeGreaterThan(0)
      expect(result.some((r) => r.name === 'Note Editor')).toBe(true)
    })
  })

  describe('scoring behavior', () => {
    it('scores earlier matches higher', () => {
      const testItems = [
        { id: 1, name: 'xyz task', description: '' },
        { id: 2, name: 'task xyz', description: '' }
      ]
      const result = fuzzySearch(testItems, 'task', ['name'])
      // 'task xyz' should be first because 'task' appears at position 0
      expect(result[0].name).toBe('task xyz')
    })

    it('applies consecutive match bonus', () => {
      const testItems = [
        { id: 1, name: 'a b c d', description: '' }, // non-consecutive
        { id: 2, name: 'abcd', description: '' } // consecutive
      ]
      const result = fuzzySearch(testItems, 'abcd', ['name'])
      // 'abcd' should rank higher due to consecutive bonus
      expect(result[0].name).toBe('abcd')
    })

    it('applies start-of-word bonus after space', () => {
      const testItems = [
        { id: 1, name: 'xtask', description: '' },
        { id: 2, name: 'x task', description: '' }
      ]
      const result = fuzzySearch(testItems, 'task', ['name'])
      // 'x task' should rank higher because 'task' is at start of word
      expect(result[0].name).toBe('x task')
    })

    it('applies start-of-word bonus after hyphen', () => {
      const testItems = [
        { id: 1, name: 'xtask', description: '' },
        { id: 2, name: 'x-task', description: '' }
      ]
      const result = fuzzySearch(testItems, 'task', ['name'])
      expect(result[0].name).toBe('x-task')
    })

    it('applies start-of-word bonus after underscore', () => {
      const testItems = [
        { id: 1, name: 'xtask', description: '' },
        { id: 2, name: 'x_task', description: '' }
      ]
      const result = fuzzySearch(testItems, 'task', ['name'])
      expect(result[0].name).toBe('x_task')
    })

    it('applies start-of-word bonus for hyphenated words', () => {
      const testItems = [
        { id: 1, name: 'mytask', description: '' },
        { id: 2, name: 'my-task', description: '' }
      ]
      const result = fuzzySearch(testItems, 'task', ['name'])
      // 'my-task' should rank higher due to hyphen word boundary
      expect(result[0].name).toBe('my-task')
    })
  })

  describe('sorting by score', () => {
    it('sorts results by score descending', () => {
      const testItems = [
        { id: 1, name: 'xxx task', description: '' },
        { id: 2, name: 'task', description: '' },
        { id: 3, name: 'x task', description: '' }
      ]
      const result = fuzzySearch(testItems, 'task', ['name'])
      // 'task' at position 0 should be first
      expect(result[0].name).toBe('task')
      // 'x task' at position 2 should be second
      expect(result[1].name).toBe('x task')
      // 'xxx task' at position 4 should be last
      expect(result[2].name).toBe('xxx task')
    })
  })

  describe('multiple keys searching', () => {
    it('searches across multiple keys', () => {
      const result = fuzzySearch(items, 'quickly', ['name', 'description'])
      expect(result).toHaveLength(1)
      expect(result[0].name).toBe('Note Editor')
      expect(result[0].description).toBe('Edit notes quickly')
    })

    it('returns best match score across keys', () => {
      const testItems = [
        { id: 1, name: 'xxxxx', description: 'task' },
        { id: 2, name: 'task', description: 'xxxxx' }
      ]
      const result = fuzzySearch(testItems, 'task', ['name', 'description'])
      // Both items match 'task' at position 0 (in different fields), so they have equal scores
      // With equal scores, original array order is preserved (stable sort)
      expect(result).toHaveLength(2)
      expect(result[0].name).toBe('xxxxx') // First in original array
      expect(result[1].name).toBe('task')  // Second in original array
    })

    it('matches in any of the specified keys', () => {
      const result = fuzzySearch(items, 'personal', ['name', 'description'])
      expect(result).toHaveLength(1)
      expect(result[0].name).toBe('My Tasks')
    })
  })

  describe('no match scenarios', () => {
    it('returns empty array when no items match', () => {
      const result = fuzzySearch(items, 'xyz123', ['name'])
      expect(result).toEqual([])
    })

    it('returns empty array when query characters do not appear in order', () => {
      const result = fuzzySearch(items, 'ksat', ['name']) // 'ksat' cannot match 'task'
      expect(result).toEqual([])
    })

    it('handles items with empty string values', () => {
      const testItems = [
        { id: 1, name: '', description: '' },
        { id: 2, name: 'task', description: '' }
      ]
      const result = fuzzySearch(testItems, 'task', ['name'])
      expect(result).toHaveLength(1)
      expect(result[0].name).toBe('task')
    })

    it('handles items with null/undefined values gracefully', () => {
      const testItems = [
        { id: 1, name: null as unknown as string, description: '' },
        { id: 2, name: 'task', description: '' }
      ]
      const result = fuzzySearch(testItems, 'task', ['name'])
      expect(result).toHaveLength(1)
      expect(result[0].name).toBe('task')
    })
  })

  describe('edge cases', () => {
    it('handles single character query', () => {
      const result = fuzzySearch(items, 't', ['name'])
      expect(result.length).toBeGreaterThan(0)
      // All items with 't' should match
      expect(result.some((r) => r.name === 'Task Manager')).toBe(true)
    })

    it('handles empty items array', () => {
      const result = fuzzySearch([], 'task', ['name'])
      expect(result).toEqual([])
    })

    it('handles query longer than any text', () => {
      const testItems = [{ id: 1, name: 'ab', description: '' }]
      const result = fuzzySearch(testItems, 'abcdefgh', ['name'])
      expect(result).toEqual([])
    })
  })
})

describe('highlightMatches', () => {
  describe('empty matches handling', () => {
    it('returns original text when matches array is empty', () => {
      const result = highlightMatches('Hello World', [])
      expect(result).toBe('Hello World')
    })

    it('returns original text when matches is null/undefined', () => {
      const result = highlightMatches('Hello World', null as unknown as number[])
      expect(result).toBe('Hello World')
    })
  })

  describe('single match highlighting', () => {
    it('wraps single matched character in mark tag', () => {
      const result = highlightMatches('Hello', [0])
      expect(result).toBe('<mark>H</mark>ello')
    })

    it('wraps middle character in mark tag', () => {
      const result = highlightMatches('Hello', [2])
      expect(result).toBe('He<mark>l</mark>lo')
    })

    it('wraps last character in mark tag', () => {
      const result = highlightMatches('Hello', [4])
      expect(result).toBe('Hell<mark>o</mark>')
    })
  })

  describe('multiple matches highlighting', () => {
    it('wraps multiple matched characters in separate mark tags', () => {
      const result = highlightMatches('Hello', [0, 2, 4])
      expect(result).toBe('<mark>H</mark>e<mark>l</mark>l<mark>o</mark>')
    })

    it('handles consecutive matches', () => {
      const result = highlightMatches('Hello', [0, 1, 2])
      expect(result).toBe('<mark>H</mark><mark>e</mark><mark>l</mark>lo')
    })

    it('handles matches at start and end', () => {
      const result = highlightMatches('abcde', [0, 4])
      expect(result).toBe('<mark>a</mark>bcd<mark>e</mark>')
    })
  })

  describe('preserving non-matched text', () => {
    it('preserves text before first match', () => {
      const result = highlightMatches('Hello World', [6])
      expect(result).toBe('Hello <mark>W</mark>orld')
    })

    it('preserves text after last match', () => {
      const result = highlightMatches('Hello World', [0])
      expect(result).toBe('<mark>H</mark>ello World')
    })

    it('preserves text between matches', () => {
      const result = highlightMatches('Hello World', [0, 6])
      expect(result).toBe('<mark>H</mark>ello <mark>W</mark>orld')
    })

    it('handles text with special characters', () => {
      const result = highlightMatches('Hello <World>', [0, 7])
      expect(result).toBe('<mark>H</mark>ello <<mark>W</mark>orld>')
    })
  })

  describe('edge cases', () => {
    it('handles empty text', () => {
      const result = highlightMatches('', [])
      expect(result).toBe('')
    })

    it('handles single character text with match', () => {
      const result = highlightMatches('a', [0])
      expect(result).toBe('<mark>a</mark>')
    })

    it('handles matches array with all indices', () => {
      const result = highlightMatches('abc', [0, 1, 2])
      expect(result).toBe('<mark>a</mark><mark>b</mark><mark>c</mark>')
    })
  })
})
