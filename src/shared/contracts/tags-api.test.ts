import { describe, it, expect } from 'vitest'
import {
  GetNotesByTagSchema,
  PinNoteToTagSchema,
  UnpinNoteFromTagSchema,
  RenameTagSchema,
  UpdateTagColorSchema,
  RemoveTagFromNoteSchema
} from './tags-api'

describe('GetNotesByTagSchema', () => {
  it('should validate minimal input with defaults', () => {
    const result = GetNotesByTagSchema.safeParse({ tag: 'design' })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.sortBy).toBe('modified')
      expect(result.data.sortOrder).toBe('desc')
    }
  })

  it('should validate full input', () => {
    const result = GetNotesByTagSchema.safeParse({
      tag: 'design-systems',
      sortBy: 'created',
      sortOrder: 'asc'
    })
    expect(result.success).toBe(true)
  })

  it('should validate all sortBy values', () => {
    const values = ['modified', 'created', 'title']
    values.forEach((sortBy) => {
      const result = GetNotesByTagSchema.safeParse({ tag: 'test', sortBy })
      expect(result.success).toBe(true)
    })
  })

  it('should validate all sortOrder values', () => {
    const values = ['asc', 'desc']
    values.forEach((sortOrder) => {
      const result = GetNotesByTagSchema.safeParse({ tag: 'test', sortOrder })
      expect(result.success).toBe(true)
    })
  })

  it('should reject empty tag', () => {
    const result = GetNotesByTagSchema.safeParse({ tag: '' })
    expect(result.success).toBe(false)
  })

  it('should reject invalid sortBy', () => {
    const result = GetNotesByTagSchema.safeParse({ tag: 'test', sortBy: 'invalid' })
    expect(result.success).toBe(false)
  })

  it('should reject invalid sortOrder', () => {
    const result = GetNotesByTagSchema.safeParse({ tag: 'test', sortOrder: 'up' })
    expect(result.success).toBe(false)
  })

  it('should reject missing tag', () => {
    const result = GetNotesByTagSchema.safeParse({})
    expect(result.success).toBe(false)
  })
})

describe('PinNoteToTagSchema', () => {
  it('should validate correct input', () => {
    const result = PinNoteToTagSchema.safeParse({
      noteId: 'note-123',
      tag: 'important'
    })
    expect(result.success).toBe(true)
  })

  it('should reject empty noteId', () => {
    const result = PinNoteToTagSchema.safeParse({
      noteId: '',
      tag: 'important'
    })
    expect(result.success).toBe(false)
  })

  it('should reject empty tag', () => {
    const result = PinNoteToTagSchema.safeParse({
      noteId: 'note-123',
      tag: ''
    })
    expect(result.success).toBe(false)
  })

  it('should reject missing noteId', () => {
    const result = PinNoteToTagSchema.safeParse({ tag: 'important' })
    expect(result.success).toBe(false)
  })

  it('should reject missing tag', () => {
    const result = PinNoteToTagSchema.safeParse({ noteId: 'note-123' })
    expect(result.success).toBe(false)
  })
})

describe('UnpinNoteFromTagSchema', () => {
  it('should validate correct input', () => {
    const result = UnpinNoteFromTagSchema.safeParse({
      noteId: 'note-123',
      tag: 'important'
    })
    expect(result.success).toBe(true)
  })

  it('should reject empty noteId', () => {
    const result = UnpinNoteFromTagSchema.safeParse({
      noteId: '',
      tag: 'important'
    })
    expect(result.success).toBe(false)
  })

  it('should reject empty tag', () => {
    const result = UnpinNoteFromTagSchema.safeParse({
      noteId: 'note-123',
      tag: ''
    })
    expect(result.success).toBe(false)
  })
})

describe('RenameTagSchema', () => {
  it('should validate correct input', () => {
    const result = RenameTagSchema.safeParse({
      oldName: 'old-tag',
      newName: 'new-tag'
    })
    expect(result.success).toBe(true)
  })

  it('should reject empty oldName', () => {
    const result = RenameTagSchema.safeParse({
      oldName: '',
      newName: 'new-tag'
    })
    expect(result.success).toBe(false)
  })

  it('should reject empty newName', () => {
    const result = RenameTagSchema.safeParse({
      oldName: 'old-tag',
      newName: ''
    })
    expect(result.success).toBe(false)
  })

  it('should reject newName over 50 chars', () => {
    const result = RenameTagSchema.safeParse({
      oldName: 'old-tag',
      newName: 'a'.repeat(51)
    })
    expect(result.success).toBe(false)
  })

  it('should accept newName at 50 chars boundary', () => {
    const result = RenameTagSchema.safeParse({
      oldName: 'old-tag',
      newName: 'a'.repeat(50)
    })
    expect(result.success).toBe(true)
  })

  it('should reject missing oldName', () => {
    const result = RenameTagSchema.safeParse({ newName: 'new-tag' })
    expect(result.success).toBe(false)
  })

  it('should reject missing newName', () => {
    const result = RenameTagSchema.safeParse({ oldName: 'old-tag' })
    expect(result.success).toBe(false)
  })
})

describe('UpdateTagColorSchema', () => {
  it('should validate correct input', () => {
    const result = UpdateTagColorSchema.safeParse({
      tag: 'important',
      color: '#ff0000'
    })
    expect(result.success).toBe(true)
  })

  it('should accept various color formats', () => {
    const colors = ['#fff', '#ffffff', 'rgb(255, 0, 0)', 'red', 'hsl(0, 100%, 50%)']
    colors.forEach((color) => {
      const result = UpdateTagColorSchema.safeParse({ tag: 'test', color })
      expect(result.success).toBe(true)
    })
  })

  it('should reject empty tag', () => {
    const result = UpdateTagColorSchema.safeParse({
      tag: '',
      color: '#ff0000'
    })
    expect(result.success).toBe(false)
  })

  it('should reject empty color', () => {
    const result = UpdateTagColorSchema.safeParse({
      tag: 'important',
      color: ''
    })
    expect(result.success).toBe(false)
  })
})

describe('RemoveTagFromNoteSchema', () => {
  it('should validate correct input', () => {
    const result = RemoveTagFromNoteSchema.safeParse({
      noteId: 'note-123',
      tag: 'old-tag'
    })
    expect(result.success).toBe(true)
  })

  it('should reject empty noteId', () => {
    const result = RemoveTagFromNoteSchema.safeParse({
      noteId: '',
      tag: 'old-tag'
    })
    expect(result.success).toBe(false)
  })

  it('should reject empty tag', () => {
    const result = RemoveTagFromNoteSchema.safeParse({
      noteId: 'note-123',
      tag: ''
    })
    expect(result.success).toBe(false)
  })

  it('should reject missing fields', () => {
    expect(RemoveTagFromNoteSchema.safeParse({ noteId: 'note-123' }).success).toBe(false)
    expect(RemoveTagFromNoteSchema.safeParse({ tag: 'test' }).success).toBe(false)
    expect(RemoveTagFromNoteSchema.safeParse({}).success).toBe(false)
  })
})
