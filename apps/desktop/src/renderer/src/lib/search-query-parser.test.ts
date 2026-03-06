import { describe, it, expect } from 'vitest'
import {
  parseSearchQuery,
  hasOperators,
  formatSearchQuery,
  getOperatorPrefixes,
  type ParsedSearchQuery
} from './search-query-parser'

describe('parseSearchQuery', () => {
  describe('empty and invalid input', () => {
    it('returns empty result for empty string', () => {
      const result = parseSearchQuery('')
      expect(result.text).toBe('')
      expect(result.operators).toEqual({})
      expect(result.raw).toBe('')
    })

    it('returns empty result for null input', () => {
      const result = parseSearchQuery(null as unknown as string)
      expect(result.text).toBe('')
      expect(result.operators).toEqual({})
    })

    it('returns empty result for undefined input', () => {
      const result = parseSearchQuery(undefined as unknown as string)
      expect(result.text).toBe('')
      expect(result.operators).toEqual({})
    })
  })

  describe('plain text queries', () => {
    it('returns text unchanged when no operators present', () => {
      const result = parseSearchQuery('meeting notes')
      expect(result.text).toBe('meeting notes')
      expect(result.operators).toEqual({})
      expect(result.raw).toBe('meeting notes')
    })

    it('trims whitespace from text', () => {
      const result = parseSearchQuery('  meeting notes  ')
      expect(result.text).toBe('meeting notes')
    })

    it('normalizes multiple spaces', () => {
      const result = parseSearchQuery('meeting   notes')
      expect(result.text).toBe('meeting notes')
    })
  })

  describe('path: operator', () => {
    it('extracts simple path value', () => {
      const result = parseSearchQuery('path:/notes/projects')
      expect(result.operators.path).toBe('/notes/projects')
      expect(result.text).toBe('')
    })

    it('extracts path with double-quoted value', () => {
      const result = parseSearchQuery('path:"my folder/notes"')
      expect(result.operators.path).toBe('my folder/notes')
    })

    it('extracts path with single-quoted value', () => {
      const result = parseSearchQuery("path:'my folder/notes'")
      expect(result.operators.path).toBe('my folder/notes')
    })

    it('extracts path with text query', () => {
      const result = parseSearchQuery('meeting notes path:/projects')
      expect(result.text).toBe('meeting notes')
      expect(result.operators.path).toBe('/projects')
    })

    it('uses only first path operator when multiple present', () => {
      const result = parseSearchQuery('path:/first path:/second')
      expect(result.operators.path).toBe('/first')
    })
  })

  describe('file: operator', () => {
    it('extracts simple file value', () => {
      const result = parseSearchQuery('file:meeting')
      expect(result.operators.file).toBe('meeting')
      expect(result.text).toBe('')
    })

    it('extracts file with double-quoted value', () => {
      const result = parseSearchQuery('file:"meeting notes.md"')
      expect(result.operators.file).toBe('meeting notes.md')
    })

    it('extracts file with text query', () => {
      const result = parseSearchQuery('agenda file:meeting')
      expect(result.text).toBe('agenda')
      expect(result.operators.file).toBe('meeting')
    })
  })

  describe('tag: operator', () => {
    it('extracts single tag', () => {
      const result = parseSearchQuery('tag:work')
      expect(result.operators.tags).toEqual(['work'])
      expect(result.text).toBe('')
    })

    it('extracts tag:book', () => {
      const result = parseSearchQuery('tag:book')
      expect(result.operators.tags).toEqual(['book'])
      expect(result.text).toBe('')
    })

    it('extracts tag with hash prefix', () => {
      const result = parseSearchQuery('tag:#work')
      expect(result.operators.tags).toEqual(['work'])
    })

    it('extracts multiple tags', () => {
      const result = parseSearchQuery('tag:work tag:urgent')
      expect(result.operators.tags).toEqual(['work', 'urgent'])
    })

    it('normalizes tags to lowercase', () => {
      const result = parseSearchQuery('tag:Work tag:URGENT')
      expect(result.operators.tags).toEqual(['work', 'urgent'])
    })

    it('extracts tag with double-quoted value', () => {
      const result = parseSearchQuery('tag:"my tag"')
      expect(result.operators.tags).toEqual(['my tag'])
    })

    it('extracts tags with text query', () => {
      const result = parseSearchQuery('meeting notes tag:work')
      expect(result.text).toBe('meeting notes')
      expect(result.operators.tags).toEqual(['work'])
    })

    it('extracts tag:book with search text', () => {
      const result = parseSearchQuery('reading list tag:book')
      expect(result.text).toBe('reading list')
      expect(result.operators.tags).toEqual(['book'])
    })
  })

  describe('[property]: operator', () => {
    it('extracts single property filter', () => {
      const result = parseSearchQuery('[status]:done')
      expect(result.operators.properties).toEqual([{ name: 'status', value: 'done' }])
      expect(result.text).toBe('')
    })

    it('extracts property with double-quoted value', () => {
      const result = parseSearchQuery('[status]:"in progress"')
      expect(result.operators.properties).toEqual([{ name: 'status', value: 'in progress' }])
    })

    it('extracts multiple properties', () => {
      const result = parseSearchQuery('[status]:done [priority]:high')
      expect(result.operators.properties).toEqual([
        { name: 'status', value: 'done' },
        { name: 'priority', value: 'high' }
      ])
    })

    it('extracts properties with text query', () => {
      const result = parseSearchQuery('meeting [status]:done')
      expect(result.text).toBe('meeting')
      expect(result.operators.properties).toEqual([{ name: 'status', value: 'done' }])
    })

    it('handles property names with spaces in brackets', () => {
      const result = parseSearchQuery('[my property]:value')
      expect(result.operators.properties).toEqual([{ name: 'my property', value: 'value' }])
    })
  })

  describe('combined operators', () => {
    it('extracts all operators from complex query', () => {
      const result = parseSearchQuery(
        'meeting notes path:/projects file:agenda tag:work [status]:done'
      )
      expect(result.text).toBe('meeting notes')
      expect(result.operators.path).toBe('/projects')
      expect(result.operators.file).toBe('agenda')
      expect(result.operators.tags).toEqual(['work'])
      expect(result.operators.properties).toEqual([{ name: 'status', value: 'done' }])
    })

    it('handles operators in any order', () => {
      const result = parseSearchQuery('tag:work meeting path:/notes notes')
      expect(result.text).toBe('meeting notes')
      expect(result.operators.tags).toEqual(['work'])
      expect(result.operators.path).toBe('/notes')
    })

    it('preserves raw query', () => {
      const query = 'meeting tag:work path:/notes'
      const result = parseSearchQuery(query)
      expect(result.raw).toBe(query)
    })
  })

  describe('edge cases', () => {
    it('handles colon in text without operator prefix', () => {
      const result = parseSearchQuery('time: 10:30')
      expect(result.text).toBe('time: 10:30')
      expect(result.operators).toEqual({})
    })

    it('handles brackets in text without colon', () => {
      const result = parseSearchQuery('[note] some text')
      expect(result.text).toBe('[note] some text')
      expect(result.operators).toEqual({})
    })

    it('ignores operators without values', () => {
      const result = parseSearchQuery('tag:')
      expect(result.operators.tags).toBeUndefined()
      expect(result.text).toBe('tag:')
    })
  })
})

describe('hasOperators', () => {
  it('returns false for empty query', () => {
    expect(hasOperators('')).toBe(false)
  })

  it('returns false for plain text', () => {
    expect(hasOperators('meeting notes')).toBe(false)
  })

  it('returns true for path operator', () => {
    expect(hasOperators('path:/notes')).toBe(true)
  })

  it('returns true for file operator', () => {
    expect(hasOperators('file:meeting')).toBe(true)
  })

  it('returns true for tag operator', () => {
    expect(hasOperators('tag:work')).toBe(true)
  })

  it('returns true for tag:book', () => {
    expect(hasOperators('tag:book')).toBe(true)
  })

  it('returns consistent results when called multiple times', () => {
    const query = 'tag:book'
    expect(hasOperators(query)).toBe(true)
    expect(hasOperators(query)).toBe(true)
    expect(hasOperators(query)).toBe(true)
    expect(hasOperators(query)).toBe(true)
    expect(hasOperators(query)).toBe(true)
  })

  it('returns true for property operator', () => {
    expect(hasOperators('[status]:done')).toBe(true)
  })
})

describe('getOperatorPrefixes', () => {
  it('returns all operator prefixes', () => {
    const prefixes = getOperatorPrefixes()
    expect(prefixes).toContain('path:')
    expect(prefixes).toContain('file:')
    expect(prefixes).toContain('tag:')
    expect(prefixes).toContain('[')
  })
})

describe('formatSearchQuery', () => {
  it('formats text-only query', () => {
    const parsed: ParsedSearchQuery = {
      text: 'meeting notes',
      operators: {},
      raw: 'meeting notes'
    }
    expect(formatSearchQuery(parsed)).toBe('meeting notes')
  })

  it('formats query with path operator', () => {
    const parsed: ParsedSearchQuery = {
      text: 'meeting',
      operators: { path: '/projects' },
      raw: ''
    }
    expect(formatSearchQuery(parsed)).toBe('meeting path:/projects')
  })

  it('formats query with path containing spaces', () => {
    const parsed: ParsedSearchQuery = {
      text: '',
      operators: { path: 'my folder' },
      raw: ''
    }
    expect(formatSearchQuery(parsed)).toBe('path:"my folder"')
  })

  it('formats query with multiple tags', () => {
    const parsed: ParsedSearchQuery = {
      text: 'meeting',
      operators: { tags: ['work', 'urgent'] },
      raw: ''
    }
    expect(formatSearchQuery(parsed)).toBe('meeting tag:work tag:urgent')
  })

  it('formats query with properties', () => {
    const parsed: ParsedSearchQuery = {
      text: '',
      operators: { properties: [{ name: 'status', value: 'done' }] },
      raw: ''
    }
    expect(formatSearchQuery(parsed)).toBe('[status]:done')
  })

  it('formats complex query with all operators', () => {
    const parsed: ParsedSearchQuery = {
      text: 'meeting',
      operators: {
        path: '/notes',
        file: 'agenda',
        tags: ['work'],
        properties: [{ name: 'status', value: 'done' }]
      },
      raw: ''
    }
    const result = formatSearchQuery(parsed)
    expect(result).toContain('meeting')
    expect(result).toContain('path:/notes')
    expect(result).toContain('file:agenda')
    expect(result).toContain('tag:work')
    expect(result).toContain('[status]:done')
  })
})
