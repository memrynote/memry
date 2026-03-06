import { describe, it, expect } from 'vitest'
import {
  SavedFilterCreateSchema,
  SavedFilterUpdateSchema,
  SavedFilterDeleteSchema,
  SavedFilterReorderSchema
} from './saved-filters-api'

describe('SavedFilterCreateSchema', () => {
  it('should validate minimal create input', () => {
    const result = SavedFilterCreateSchema.safeParse({
      name: 'My Filter',
      config: {
        filters: {}
      }
    })
    expect(result.success).toBe(true)
  })

  it('should validate full create input', () => {
    const result = SavedFilterCreateSchema.safeParse({
      name: 'Active High Priority',
      config: {
        filters: {
          search: 'important',
          projectIds: ['proj-1', 'proj-2'],
          priorities: ['high', 'urgent'],
          dueDate: { type: 'this-week' },
          statusIds: ['status-1'],
          completion: 'active',
          repeatType: 'all',
          hasTime: 'all'
        },
        sort: {
          field: 'priority',
          direction: 'desc'
        }
      }
    })
    expect(result.success).toBe(true)
  })

  it('should reject empty name', () => {
    const result = SavedFilterCreateSchema.safeParse({
      name: '',
      config: { filters: {} }
    })
    expect(result.success).toBe(false)
  })

  it('should reject name over 100 chars', () => {
    const result = SavedFilterCreateSchema.safeParse({
      name: 'a'.repeat(101),
      config: { filters: {} }
    })
    expect(result.success).toBe(false)
  })

  it('should accept name at 100 chars boundary', () => {
    const result = SavedFilterCreateSchema.safeParse({
      name: 'a'.repeat(100),
      config: { filters: {} }
    })
    expect(result.success).toBe(true)
  })

  it('should reject missing config', () => {
    const result = SavedFilterCreateSchema.safeParse({
      name: 'My Filter'
    })
    expect(result.success).toBe(false)
  })

  it('should validate all due date types', () => {
    const types = [
      'any',
      'none',
      'overdue',
      'today',
      'tomorrow',
      'this-week',
      'next-week',
      'this-month',
      'custom'
    ]
    types.forEach((type) => {
      const result = SavedFilterCreateSchema.safeParse({
        name: 'Filter',
        config: {
          filters: {
            dueDate: { type }
          }
        }
      })
      expect(result.success).toBe(true)
    })
  })

  it('should validate custom due date with dates', () => {
    const result = SavedFilterCreateSchema.safeParse({
      name: 'Custom Range',
      config: {
        filters: {
          dueDate: {
            type: 'custom',
            customStart: '2026-01-01',
            customEnd: '2026-01-31'
          }
        }
      }
    })
    expect(result.success).toBe(true)
  })

  it('should validate all priority values', () => {
    const priorities = ['urgent', 'high', 'medium', 'low', 'none']
    const result = SavedFilterCreateSchema.safeParse({
      name: 'All Priorities',
      config: {
        filters: {
          priorities
        }
      }
    })
    expect(result.success).toBe(true)
  })

  it('should validate all completion values', () => {
    const values = ['active', 'completed', 'all']
    values.forEach((completion) => {
      const result = SavedFilterCreateSchema.safeParse({
        name: 'Filter',
        config: { filters: { completion } }
      })
      expect(result.success).toBe(true)
    })
  })

  it('should validate all repeatType values', () => {
    const values = ['all', 'repeating', 'one-time']
    values.forEach((repeatType) => {
      const result = SavedFilterCreateSchema.safeParse({
        name: 'Filter',
        config: { filters: { repeatType } }
      })
      expect(result.success).toBe(true)
    })
  })

  it('should validate all hasTime values', () => {
    const values = ['all', 'with-time', 'without-time']
    values.forEach((hasTime) => {
      const result = SavedFilterCreateSchema.safeParse({
        name: 'Filter',
        config: { filters: { hasTime } }
      })
      expect(result.success).toBe(true)
    })
  })

  it('should validate all sort fields', () => {
    const fields = ['dueDate', 'priority', 'createdAt', 'title', 'project', 'completedAt']
    fields.forEach((field) => {
      const result = SavedFilterCreateSchema.safeParse({
        name: 'Filter',
        config: {
          filters: {},
          sort: { field, direction: 'asc' }
        }
      })
      expect(result.success).toBe(true)
    })
  })

  it('should reject invalid sort field', () => {
    const result = SavedFilterCreateSchema.safeParse({
      name: 'Filter',
      config: {
        filters: {},
        sort: { field: 'invalid', direction: 'asc' }
      }
    })
    expect(result.success).toBe(false)
  })

  it('should reject invalid sort direction', () => {
    const result = SavedFilterCreateSchema.safeParse({
      name: 'Filter',
      config: {
        filters: {},
        sort: { field: 'title', direction: 'up' }
      }
    })
    expect(result.success).toBe(false)
  })
})

describe('SavedFilterUpdateSchema', () => {
  it('should validate minimal update (id only)', () => {
    const result = SavedFilterUpdateSchema.safeParse({ id: 'filter-1' })
    expect(result.success).toBe(true)
  })

  it('should validate update with name', () => {
    const result = SavedFilterUpdateSchema.safeParse({
      id: 'filter-1',
      name: 'Updated Name'
    })
    expect(result.success).toBe(true)
  })

  it('should validate update with config', () => {
    const result = SavedFilterUpdateSchema.safeParse({
      id: 'filter-1',
      config: {
        filters: { completion: 'completed' }
      }
    })
    expect(result.success).toBe(true)
  })

  it('should validate update with position', () => {
    const result = SavedFilterUpdateSchema.safeParse({
      id: 'filter-1',
      position: 5
    })
    expect(result.success).toBe(true)
  })

  it('should validate full update', () => {
    const result = SavedFilterUpdateSchema.safeParse({
      id: 'filter-1',
      name: 'New Name',
      config: {
        filters: { search: 'new search' },
        sort: { field: 'dueDate', direction: 'asc' }
      },
      position: 0
    })
    expect(result.success).toBe(true)
  })

  it('should reject missing id', () => {
    const result = SavedFilterUpdateSchema.safeParse({
      name: 'Updated Name'
    })
    expect(result.success).toBe(false)
  })

  it('should reject negative position', () => {
    const result = SavedFilterUpdateSchema.safeParse({
      id: 'filter-1',
      position: -1
    })
    expect(result.success).toBe(false)
  })

  it('should reject empty name', () => {
    const result = SavedFilterUpdateSchema.safeParse({
      id: 'filter-1',
      name: ''
    })
    expect(result.success).toBe(false)
  })

  it('should reject name over 100 chars', () => {
    const result = SavedFilterUpdateSchema.safeParse({
      id: 'filter-1',
      name: 'a'.repeat(101)
    })
    expect(result.success).toBe(false)
  })
})

describe('SavedFilterDeleteSchema', () => {
  it('should validate delete input', () => {
    const result = SavedFilterDeleteSchema.safeParse({ id: 'filter-1' })
    expect(result.success).toBe(true)
  })

  it('should reject missing id', () => {
    const result = SavedFilterDeleteSchema.safeParse({})
    expect(result.success).toBe(false)
  })
})

describe('SavedFilterReorderSchema', () => {
  it('should validate reorder input', () => {
    const result = SavedFilterReorderSchema.safeParse({
      ids: ['filter-1', 'filter-2', 'filter-3'],
      positions: [0, 1, 2]
    })
    expect(result.success).toBe(true)
  })

  it('should validate empty arrays', () => {
    const result = SavedFilterReorderSchema.safeParse({
      ids: [],
      positions: []
    })
    expect(result.success).toBe(true)
  })

  it('should reject missing ids', () => {
    const result = SavedFilterReorderSchema.safeParse({
      positions: [0, 1, 2]
    })
    expect(result.success).toBe(false)
  })

  it('should reject missing positions', () => {
    const result = SavedFilterReorderSchema.safeParse({
      ids: ['filter-1', 'filter-2']
    })
    expect(result.success).toBe(false)
  })

  it('should reject non-integer positions', () => {
    const result = SavedFilterReorderSchema.safeParse({
      ids: ['filter-1'],
      positions: [1.5]
    })
    expect(result.success).toBe(false)
  })
})
