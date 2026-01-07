import { describe, it, expect } from 'vitest'
import {
  BookmarkCreateSchema,
  BookmarkCheckSchema,
  BookmarkToggleSchema,
  BookmarkReorderSchema,
  BookmarkListSchema,
  BookmarkBulkDeleteSchema,
  BookmarkBulkCreateSchema
} from './bookmarks-api'

// =============================================================================
// BookmarkCreateSchema Tests
// =============================================================================

describe('BookmarkCreateSchema', () => {
  it('should validate correct create input', () => {
    const result = BookmarkCreateSchema.safeParse({
      itemType: 'note',
      itemId: 'note-abc123'
    })
    expect(result.success).toBe(true)
  })

  it('should validate with task itemType', () => {
    const result = BookmarkCreateSchema.safeParse({
      itemType: 'task',
      itemId: 'task-xyz789'
    })
    expect(result.success).toBe(true)
  })

  it('should validate with project itemType', () => {
    const result = BookmarkCreateSchema.safeParse({
      itemType: 'project',
      itemId: 'proj-123'
    })
    expect(result.success).toBe(true)
  })

  it('should reject empty itemId', () => {
    const result = BookmarkCreateSchema.safeParse({
      itemType: 'note',
      itemId: ''
    })
    expect(result.success).toBe(false)
  })

  it('should reject missing itemType', () => {
    const result = BookmarkCreateSchema.safeParse({
      itemId: 'note-abc123'
    })
    expect(result.success).toBe(false)
  })

  it('should reject missing itemId', () => {
    const result = BookmarkCreateSchema.safeParse({
      itemType: 'note'
    })
    expect(result.success).toBe(false)
  })
})

// =============================================================================
// BookmarkCheckSchema Tests
// =============================================================================

describe('BookmarkCheckSchema', () => {
  it('should validate correct check input', () => {
    const result = BookmarkCheckSchema.safeParse({
      itemType: 'note',
      itemId: 'note-123'
    })
    expect(result.success).toBe(true)
  })

  it('should reject empty itemId', () => {
    const result = BookmarkCheckSchema.safeParse({
      itemType: 'note',
      itemId: ''
    })
    expect(result.success).toBe(false)
  })
})

// =============================================================================
// BookmarkToggleSchema Tests
// =============================================================================

describe('BookmarkToggleSchema', () => {
  it('should validate correct toggle input', () => {
    const result = BookmarkToggleSchema.safeParse({
      itemType: 'journal',
      itemId: 'j2025-01-03'
    })
    expect(result.success).toBe(true)
  })

  it('should reject missing fields', () => {
    const result = BookmarkToggleSchema.safeParse({
      itemType: 'journal'
    })
    expect(result.success).toBe(false)
  })
})

// =============================================================================
// BookmarkReorderSchema Tests
// =============================================================================

describe('BookmarkReorderSchema', () => {
  it('should validate correct reorder input', () => {
    const result = BookmarkReorderSchema.safeParse({
      bookmarkIds: ['bm-1', 'bm-2', 'bm-3']
    })
    expect(result.success).toBe(true)
  })

  it('should validate empty array', () => {
    const result = BookmarkReorderSchema.safeParse({
      bookmarkIds: []
    })
    expect(result.success).toBe(true)
  })

  it('should validate single bookmark', () => {
    const result = BookmarkReorderSchema.safeParse({
      bookmarkIds: ['bm-1']
    })
    expect(result.success).toBe(true)
  })

  it('should reject array with empty string', () => {
    const result = BookmarkReorderSchema.safeParse({
      bookmarkIds: ['bm-1', '', 'bm-3']
    })
    expect(result.success).toBe(false)
  })

  it('should reject missing bookmarkIds', () => {
    const result = BookmarkReorderSchema.safeParse({})
    expect(result.success).toBe(false)
  })
})

// =============================================================================
// BookmarkListSchema Tests
// =============================================================================

describe('BookmarkListSchema', () => {
  it('should validate empty object with defaults', () => {
    const result = BookmarkListSchema.safeParse({})
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.sortBy).toBe('position')
      expect(result.data.sortOrder).toBe('asc')
      expect(result.data.limit).toBe(100)
      expect(result.data.offset).toBe(0)
    }
  })

  it('should validate with itemType filter', () => {
    const result = BookmarkListSchema.safeParse({
      itemType: 'note'
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.itemType).toBe('note')
    }
  })

  it('should validate with sortBy createdAt', () => {
    const result = BookmarkListSchema.safeParse({
      sortBy: 'createdAt',
      sortOrder: 'desc'
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.sortBy).toBe('createdAt')
      expect(result.data.sortOrder).toBe('desc')
    }
  })

  it('should validate with limit and offset', () => {
    const result = BookmarkListSchema.safeParse({
      limit: 50,
      offset: 100
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.limit).toBe(50)
      expect(result.data.offset).toBe(100)
    }
  })

  it('should reject invalid sortBy', () => {
    const result = BookmarkListSchema.safeParse({
      sortBy: 'title' // Invalid
    })
    expect(result.success).toBe(false)
  })

  it('should reject limit below 1', () => {
    const result = BookmarkListSchema.safeParse({
      limit: 0
    })
    expect(result.success).toBe(false)
  })

  it('should reject limit above 1000', () => {
    const result = BookmarkListSchema.safeParse({
      limit: 1001
    })
    expect(result.success).toBe(false)
  })

  it('should reject negative offset', () => {
    const result = BookmarkListSchema.safeParse({
      offset: -1
    })
    expect(result.success).toBe(false)
  })
})

// =============================================================================
// BookmarkBulkDeleteSchema Tests
// =============================================================================

describe('BookmarkBulkDeleteSchema', () => {
  it('should validate correct bulk delete input', () => {
    const result = BookmarkBulkDeleteSchema.safeParse({
      bookmarkIds: ['bm-1', 'bm-2', 'bm-3']
    })
    expect(result.success).toBe(true)
  })

  it('should validate single bookmark deletion', () => {
    const result = BookmarkBulkDeleteSchema.safeParse({
      bookmarkIds: ['bm-1']
    })
    expect(result.success).toBe(true)
  })

  it('should reject empty array', () => {
    const result = BookmarkBulkDeleteSchema.safeParse({
      bookmarkIds: []
    })
    expect(result.success).toBe(false)
  })

  it('should reject array with empty string', () => {
    const result = BookmarkBulkDeleteSchema.safeParse({
      bookmarkIds: ['bm-1', '']
    })
    expect(result.success).toBe(false)
  })
})

// =============================================================================
// BookmarkBulkCreateSchema Tests
// =============================================================================

describe('BookmarkBulkCreateSchema', () => {
  it('should validate correct bulk create input', () => {
    const result = BookmarkBulkCreateSchema.safeParse({
      items: [
        { itemType: 'note', itemId: 'note-1' },
        { itemType: 'task', itemId: 'task-1' },
        { itemType: 'project', itemId: 'proj-1' }
      ]
    })
    expect(result.success).toBe(true)
  })

  it('should validate empty items array', () => {
    const result = BookmarkBulkCreateSchema.safeParse({
      items: []
    })
    expect(result.success).toBe(true)
  })

  it('should validate single item', () => {
    const result = BookmarkBulkCreateSchema.safeParse({
      items: [{ itemType: 'note', itemId: 'note-1' }]
    })
    expect(result.success).toBe(true)
  })

  it('should reject item with empty itemId', () => {
    const result = BookmarkBulkCreateSchema.safeParse({
      items: [{ itemType: 'note', itemId: '' }]
    })
    expect(result.success).toBe(false)
  })

  it('should reject missing items array', () => {
    const result = BookmarkBulkCreateSchema.safeParse({})
    expect(result.success).toBe(false)
  })

  it('should reject item missing itemType', () => {
    const result = BookmarkBulkCreateSchema.safeParse({
      items: [{ itemId: 'note-1' }]
    })
    expect(result.success).toBe(false)
  })
})
