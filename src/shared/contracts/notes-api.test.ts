/**
 * Notes API Contract Tests
 *
 * Comprehensive Zod schema validation tests for the notes API.
 */

import { describe, it, expect } from 'vitest'
import {
  NoteCreateSchema,
  NoteUpdateSchema,
  NoteRenameSchema,
  NoteMoveSchema,
  NoteListSchema
} from './notes-api'

// ============================================================================
// NoteCreateSchema Tests
// ============================================================================

describe('NoteCreateSchema', () => {
  describe('valid inputs', () => {
    it('should accept minimal valid input with just title', () => {
      const result = NoteCreateSchema.safeParse({
        title: 'My Note'
      })
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.title).toBe('My Note')
        expect(result.data.content).toBe('')
      }
    })

    it('should accept full valid input with all fields', () => {
      const result = NoteCreateSchema.safeParse({
        title: 'Project Notes',
        content: '# Hello\n\nThis is my note content.',
        folder: 'projects/2024',
        tags: ['work', 'important'],
        template: 'meeting-notes'
      })
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.title).toBe('Project Notes')
        expect(result.data.content).toBe('# Hello\n\nThis is my note content.')
        expect(result.data.folder).toBe('projects/2024')
        expect(result.data.tags).toEqual(['work', 'important'])
        expect(result.data.template).toBe('meeting-notes')
      }
    })

    it('should accept title at maximum length (200 chars)', () => {
      const longTitle = 'a'.repeat(200)
      const result = NoteCreateSchema.safeParse({
        title: longTitle
      })
      expect(result.success).toBe(true)
    })

    it('should accept empty tags array', () => {
      const result = NoteCreateSchema.safeParse({
        title: 'Test',
        tags: []
      })
      expect(result.success).toBe(true)
    })

    it('should accept maximum 50 tags', () => {
      const tags = Array.from({ length: 50 }, (_, i) => `tag${i}`)
      const result = NoteCreateSchema.safeParse({
        title: 'Test',
        tags
      })
      expect(result.success).toBe(true)
    })

    it('should accept tag at maximum length (50 chars)', () => {
      const result = NoteCreateSchema.safeParse({
        title: 'Test',
        tags: ['a'.repeat(50)]
      })
      expect(result.success).toBe(true)
    })
  })

  describe('invalid inputs', () => {
    it('should reject empty title', () => {
      const result = NoteCreateSchema.safeParse({
        title: ''
      })
      expect(result.success).toBe(false)
    })

    it('should reject missing title', () => {
      const result = NoteCreateSchema.safeParse({
        content: 'Some content'
      })
      expect(result.success).toBe(false)
    })

    it('should reject title exceeding 200 characters', () => {
      const result = NoteCreateSchema.safeParse({
        title: 'a'.repeat(201)
      })
      expect(result.success).toBe(false)
    })

    it('should reject more than 50 tags', () => {
      const tags = Array.from({ length: 51 }, (_, i) => `tag${i}`)
      const result = NoteCreateSchema.safeParse({
        title: 'Test',
        tags
      })
      expect(result.success).toBe(false)
    })

    it('should reject tag exceeding 50 characters', () => {
      const result = NoteCreateSchema.safeParse({
        title: 'Test',
        tags: ['a'.repeat(51)]
      })
      expect(result.success).toBe(false)
    })

    it('should reject non-string title', () => {
      const result = NoteCreateSchema.safeParse({
        title: 123
      })
      expect(result.success).toBe(false)
    })

    it('should reject non-array tags', () => {
      const result = NoteCreateSchema.safeParse({
        title: 'Test',
        tags: 'not-an-array'
      })
      expect(result.success).toBe(false)
    })
  })
})

// ============================================================================
// NoteUpdateSchema Tests
// ============================================================================

describe('NoteUpdateSchema', () => {
  describe('valid inputs', () => {
    it('should accept update with just id', () => {
      const result = NoteUpdateSchema.safeParse({
        id: 'note-123'
      })
      expect(result.success).toBe(true)
    })

    it('should accept full update with all optional fields', () => {
      const result = NoteUpdateSchema.safeParse({
        id: 'note-123',
        title: 'Updated Title',
        content: 'Updated content',
        tags: ['updated', 'tags'],
        frontmatter: { status: 'in-progress', priority: 3 },
        emoji: '📝'
      })
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.emoji).toBe('📝')
        expect(result.data.frontmatter).toEqual({ status: 'in-progress', priority: 3 })
      }
    })

    it('should accept null emoji (to remove emoji)', () => {
      const result = NoteUpdateSchema.safeParse({
        id: 'note-123',
        emoji: null
      })
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.emoji).toBeNull()
      }
    })

    it('should accept partial update with only title', () => {
      const result = NoteUpdateSchema.safeParse({
        id: 'note-123',
        title: 'New Title Only'
      })
      expect(result.success).toBe(true)
    })

    it('should accept partial update with only content', () => {
      const result = NoteUpdateSchema.safeParse({
        id: 'note-123',
        content: 'New content only'
      })
      expect(result.success).toBe(true)
    })

    it('should accept custom frontmatter with various types', () => {
      const result = NoteUpdateSchema.safeParse({
        id: 'note-123',
        frontmatter: {
          status: 'done',
          priority: 5,
          dueDate: '2025-01-15',
          completed: true,
          nested: { key: 'value' }
        }
      })
      expect(result.success).toBe(true)
    })
  })

  describe('invalid inputs', () => {
    it('should reject missing id', () => {
      const result = NoteUpdateSchema.safeParse({
        title: 'Updated Title'
      })
      expect(result.success).toBe(false)
    })

    it('should reject title exceeding 200 characters', () => {
      const result = NoteUpdateSchema.safeParse({
        id: 'note-123',
        title: 'a'.repeat(201)
      })
      expect(result.success).toBe(false)
    })

    it('should reject empty title if provided', () => {
      const result = NoteUpdateSchema.safeParse({
        id: 'note-123',
        title: ''
      })
      expect(result.success).toBe(false)
    })

    it('should reject more than 50 tags', () => {
      const tags = Array.from({ length: 51 }, (_, i) => `tag${i}`)
      const result = NoteUpdateSchema.safeParse({
        id: 'note-123',
        tags
      })
      expect(result.success).toBe(false)
    })

    it('should reject non-string id', () => {
      const result = NoteUpdateSchema.safeParse({
        id: 12345
      })
      expect(result.success).toBe(false)
    })

    it('should reject non-object frontmatter', () => {
      const result = NoteUpdateSchema.safeParse({
        id: 'note-123',
        frontmatter: 'not-an-object'
      })
      expect(result.success).toBe(false)
    })
  })
})

// ============================================================================
// NoteRenameSchema Tests
// ============================================================================

describe('NoteRenameSchema', () => {
  describe('valid inputs', () => {
    it('should accept valid rename input', () => {
      const result = NoteRenameSchema.safeParse({
        id: 'note-123',
        newTitle: 'New Note Title'
      })
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.id).toBe('note-123')
        expect(result.data.newTitle).toBe('New Note Title')
      }
    })

    it('should accept newTitle at maximum length (200 chars)', () => {
      const result = NoteRenameSchema.safeParse({
        id: 'note-123',
        newTitle: 'a'.repeat(200)
      })
      expect(result.success).toBe(true)
    })

    it('should accept single character title', () => {
      const result = NoteRenameSchema.safeParse({
        id: 'note-123',
        newTitle: 'A'
      })
      expect(result.success).toBe(true)
    })
  })

  describe('invalid inputs', () => {
    it('should reject missing id', () => {
      const result = NoteRenameSchema.safeParse({
        newTitle: 'New Title'
      })
      expect(result.success).toBe(false)
    })

    it('should reject missing newTitle', () => {
      const result = NoteRenameSchema.safeParse({
        id: 'note-123'
      })
      expect(result.success).toBe(false)
    })

    it('should reject empty newTitle', () => {
      const result = NoteRenameSchema.safeParse({
        id: 'note-123',
        newTitle: ''
      })
      expect(result.success).toBe(false)
    })

    it('should reject newTitle exceeding 200 characters', () => {
      const result = NoteRenameSchema.safeParse({
        id: 'note-123',
        newTitle: 'a'.repeat(201)
      })
      expect(result.success).toBe(false)
    })
  })
})

// ============================================================================
// NoteMoveSchema Tests
// ============================================================================

describe('NoteMoveSchema', () => {
  describe('valid inputs', () => {
    it('should accept valid move input', () => {
      const result = NoteMoveSchema.safeParse({
        id: 'note-123',
        newFolder: 'projects/archive'
      })
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.id).toBe('note-123')
        expect(result.data.newFolder).toBe('projects/archive')
      }
    })

    it('should accept empty string for root folder', () => {
      const result = NoteMoveSchema.safeParse({
        id: 'note-123',
        newFolder: ''
      })
      expect(result.success).toBe(true)
    })

    it('should accept deeply nested folder path', () => {
      const result = NoteMoveSchema.safeParse({
        id: 'note-123',
        newFolder: 'projects/2024/q1/meetings/weekly'
      })
      expect(result.success).toBe(true)
    })
  })

  describe('invalid inputs', () => {
    it('should reject missing id', () => {
      const result = NoteMoveSchema.safeParse({
        newFolder: 'projects'
      })
      expect(result.success).toBe(false)
    })

    it('should reject missing newFolder', () => {
      const result = NoteMoveSchema.safeParse({
        id: 'note-123'
      })
      expect(result.success).toBe(false)
    })

    it('should reject non-string id', () => {
      const result = NoteMoveSchema.safeParse({
        id: 123,
        newFolder: 'projects'
      })
      expect(result.success).toBe(false)
    })

    it('should reject non-string newFolder', () => {
      const result = NoteMoveSchema.safeParse({
        id: 'note-123',
        newFolder: ['projects']
      })
      expect(result.success).toBe(false)
    })
  })
})

// ============================================================================
// NoteListSchema Tests
// ============================================================================

describe('NoteListSchema', () => {
  describe('valid inputs', () => {
    it('should accept empty object and apply defaults', () => {
      const result = NoteListSchema.safeParse({})
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.sortBy).toBe('modified')
        expect(result.data.sortOrder).toBe('desc')
        expect(result.data.limit).toBe(100)
        expect(result.data.offset).toBe(0)
      }
    })

    it('should accept full valid input', () => {
      const result = NoteListSchema.safeParse({
        folder: 'projects',
        tags: ['work', 'important'],
        sortBy: 'created',
        sortOrder: 'asc',
        limit: 50,
        offset: 100
      })
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.folder).toBe('projects')
        expect(result.data.tags).toEqual(['work', 'important'])
        expect(result.data.sortBy).toBe('created')
        expect(result.data.sortOrder).toBe('asc')
        expect(result.data.limit).toBe(50)
        expect(result.data.offset).toBe(100)
      }
    })

    it('should accept sortBy: title', () => {
      const result = NoteListSchema.safeParse({
        sortBy: 'title'
      })
      expect(result.success).toBe(true)
    })

    it('should accept sortBy: created', () => {
      const result = NoteListSchema.safeParse({
        sortBy: 'created'
      })
      expect(result.success).toBe(true)
    })

    it('should accept sortBy: modified', () => {
      const result = NoteListSchema.safeParse({
        sortBy: 'modified'
      })
      expect(result.success).toBe(true)
    })

    it('should accept minimum limit (1)', () => {
      const result = NoteListSchema.safeParse({
        limit: 1
      })
      expect(result.success).toBe(true)
    })

    it('should accept maximum limit (10000)', () => {
      const result = NoteListSchema.safeParse({
        limit: 10000
      })
      expect(result.success).toBe(true)
    })

    it('should accept offset of 0', () => {
      const result = NoteListSchema.safeParse({
        offset: 0
      })
      expect(result.success).toBe(true)
    })

    it('should accept large offset', () => {
      const result = NoteListSchema.safeParse({
        offset: 999999
      })
      expect(result.success).toBe(true)
    })
  })

  describe('invalid inputs', () => {
    it('should reject invalid sortBy value', () => {
      const result = NoteListSchema.safeParse({
        sortBy: 'invalid'
      })
      expect(result.success).toBe(false)
    })

    it('should reject invalid sortOrder value', () => {
      const result = NoteListSchema.safeParse({
        sortOrder: 'ascending'
      })
      expect(result.success).toBe(false)
    })

    it('should reject limit below 1', () => {
      const result = NoteListSchema.safeParse({
        limit: 0
      })
      expect(result.success).toBe(false)
    })

    it('should reject limit above 10000', () => {
      const result = NoteListSchema.safeParse({
        limit: 10001
      })
      expect(result.success).toBe(false)
    })

    it('should reject negative offset', () => {
      const result = NoteListSchema.safeParse({
        offset: -1
      })
      expect(result.success).toBe(false)
    })

    it('should reject non-integer limit', () => {
      const result = NoteListSchema.safeParse({
        limit: 50.5
      })
      expect(result.success).toBe(false)
    })

    it('should reject non-integer offset', () => {
      const result = NoteListSchema.safeParse({
        offset: 10.5
      })
      expect(result.success).toBe(false)
    })

    it('should reject non-array tags', () => {
      const result = NoteListSchema.safeParse({
        tags: 'work'
      })
      expect(result.success).toBe(false)
    })
  })
})
