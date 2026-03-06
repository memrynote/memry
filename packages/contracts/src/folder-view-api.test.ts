import { describe, it, expect } from 'vitest'
import {
  ColumnConfigSchema,
  FilterExpressionSchema,
  OrderConfigSchema,
  GroupByConfigSchema,
  PropertyDisplaySchema,
  SummaryConfigSchema,
  ViewConfigSchema,
  FolderViewConfigSchema,
  GetConfigRequestSchema,
  SetConfigRequestSchema,
  GetViewsRequestSchema,
  SetViewRequestSchema,
  DeleteViewRequestSchema,
  ListWithPropertiesRequestSchema,
  GetAvailablePropertiesRequestSchema,
  GetFolderSuggestionsRequestSchema,
  BUILT_IN_COLUMNS,
  DEFAULT_COLUMNS,
  DEFAULT_VIEW
} from './folder-view-api'

describe('ColumnConfigSchema', () => {
  it('should validate minimal column config', () => {
    const result = ColumnConfigSchema.safeParse({ id: 'title' })
    expect(result.success).toBe(true)
  })

  it('should validate full column config', () => {
    const result = ColumnConfigSchema.safeParse({
      id: 'status',
      width: 150,
      displayName: 'Status',
      showSummary: true
    })
    expect(result.success).toBe(true)
  })

  it('should reject empty id', () => {
    const result = ColumnConfigSchema.safeParse({ id: '' })
    expect(result.success).toBe(false)
  })

  it('should reject width below 50', () => {
    const result = ColumnConfigSchema.safeParse({ id: 'title', width: 49 })
    expect(result.success).toBe(false)
  })

  it('should reject width above 800', () => {
    const result = ColumnConfigSchema.safeParse({ id: 'title', width: 801 })
    expect(result.success).toBe(false)
  })

  it('should accept width at boundaries (50 and 800)', () => {
    expect(ColumnConfigSchema.safeParse({ id: 'title', width: 50 }).success).toBe(true)
    expect(ColumnConfigSchema.safeParse({ id: 'title', width: 800 }).success).toBe(true)
  })
})

describe('FilterExpressionSchema', () => {
  it('should validate simple string expression', () => {
    const result = FilterExpressionSchema.safeParse('status == "done"')
    expect(result.success).toBe(true)
  })

  it('should validate AND expression', () => {
    const result = FilterExpressionSchema.safeParse({
      and: ['status != "done"', 'priority >= 3']
    })
    expect(result.success).toBe(true)
  })

  it('should validate OR expression', () => {
    const result = FilterExpressionSchema.safeParse({
      or: ['status == "urgent"', 'priority >= 5']
    })
    expect(result.success).toBe(true)
  })

  it('should validate NOT expression', () => {
    const result = FilterExpressionSchema.safeParse({
      not: 'status == "archived"'
    })
    expect(result.success).toBe(true)
  })

  it('should validate nested expressions', () => {
    const result = FilterExpressionSchema.safeParse({
      and: ['status != "done"', { or: ['priority >= 3', 'formula.is_overdue == true'] }]
    })
    expect(result.success).toBe(true)
  })

  it('should validate deeply nested expressions', () => {
    const result = FilterExpressionSchema.safeParse({
      and: [{ or: ['a', 'b'] }, { not: { and: ['c', 'd'] } }]
    })
    expect(result.success).toBe(true)
  })
})

describe('OrderConfigSchema', () => {
  it('should validate ascending order', () => {
    const result = OrderConfigSchema.safeParse({ property: 'title', direction: 'asc' })
    expect(result.success).toBe(true)
  })

  it('should validate descending order', () => {
    const result = OrderConfigSchema.safeParse({ property: 'modified', direction: 'desc' })
    expect(result.success).toBe(true)
  })

  it('should reject empty property', () => {
    const result = OrderConfigSchema.safeParse({ property: '', direction: 'asc' })
    expect(result.success).toBe(false)
  })

  it('should reject invalid direction', () => {
    const result = OrderConfigSchema.safeParse({ property: 'title', direction: 'up' })
    expect(result.success).toBe(false)
  })
})

describe('GroupByConfigSchema', () => {
  it('should validate minimal groupBy config', () => {
    const result = GroupByConfigSchema.safeParse({ property: 'status' })
    expect(result.success).toBe(true)
  })

  it('should validate full groupBy config', () => {
    const result = GroupByConfigSchema.safeParse({
      property: 'status',
      direction: 'asc',
      collapsed: true,
      showSummary: true
    })
    expect(result.success).toBe(true)
  })

  it('should reject empty property', () => {
    const result = GroupByConfigSchema.safeParse({ property: '' })
    expect(result.success).toBe(false)
  })
})

describe('PropertyDisplaySchema', () => {
  it('should validate empty object', () => {
    const result = PropertyDisplaySchema.safeParse({})
    expect(result.success).toBe(true)
  })

  it('should validate full property display', () => {
    const result = PropertyDisplaySchema.safeParse({
      displayName: 'Custom Name',
      color: true,
      dateFormat: 'yyyy-MM-dd',
      numberFormat: '0.00',
      hidden: false
    })
    expect(result.success).toBe(true)
  })
})

describe('SummaryConfigSchema', () => {
  it('should validate sum type', () => {
    const result = SummaryConfigSchema.safeParse({ type: 'sum' })
    expect(result.success).toBe(true)
  })

  it('should validate all aggregation types', () => {
    const types = ['sum', 'average', 'min', 'max', 'count', 'countBy', 'countUnique', 'custom']
    types.forEach((type) => {
      expect(SummaryConfigSchema.safeParse({ type }).success).toBe(true)
    })
  })

  it('should validate custom type with expression', () => {
    const result = SummaryConfigSchema.safeParse({
      type: 'custom',
      label: 'Total',
      expression: 'sum(priority)'
    })
    expect(result.success).toBe(true)
  })

  it('should reject invalid type', () => {
    const result = SummaryConfigSchema.safeParse({ type: 'invalid' })
    expect(result.success).toBe(false)
  })
})

describe('ViewConfigSchema', () => {
  it('should validate minimal view config', () => {
    const result = ViewConfigSchema.safeParse({ name: 'My View' })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.type).toBe('table') // default
    }
  })

  it('should validate full view config', () => {
    const result = ViewConfigSchema.safeParse({
      name: 'Active Tasks',
      type: 'kanban',
      default: true,
      columns: [{ id: 'title', width: 250 }],
      filters: { and: ['status != "done"'] },
      order: [{ property: 'priority', direction: 'desc' }],
      groupBy: { property: 'status' },
      limit: 100,
      showSummaries: true
    })
    expect(result.success).toBe(true)
  })

  it('should validate all view types', () => {
    const types = ['table', 'grid', 'list', 'kanban']
    types.forEach((type) => {
      expect(ViewConfigSchema.safeParse({ name: 'View', type }).success).toBe(true)
    })
  })

  it('should reject empty name', () => {
    const result = ViewConfigSchema.safeParse({ name: '' })
    expect(result.success).toBe(false)
  })

  it('should reject invalid type', () => {
    const result = ViewConfigSchema.safeParse({ name: 'View', type: 'invalid' })
    expect(result.success).toBe(false)
  })

  it('should reject limit below 1', () => {
    const result = ViewConfigSchema.safeParse({ name: 'View', limit: 0 })
    expect(result.success).toBe(false)
  })

  it('should reject limit above 10000', () => {
    const result = ViewConfigSchema.safeParse({ name: 'View', limit: 10001 })
    expect(result.success).toBe(false)
  })
})

describe('FolderViewConfigSchema', () => {
  it('should validate minimal config', () => {
    const result = FolderViewConfigSchema.safeParse({ path: 'projects' })
    expect(result.success).toBe(true)
  })

  it('should validate full config', () => {
    const result = FolderViewConfigSchema.safeParse({
      path: 'projects',
      template: 'project-template',
      inherit: true,
      formulas: { is_overdue: 'due < now()' },
      properties: { status: { displayName: 'Status', color: true } },
      summaries: { priority: { type: 'average' } },
      views: [{ name: 'All', type: 'table' }]
    })
    expect(result.success).toBe(true)
  })
})

describe('Request Schemas', () => {
  describe('GetConfigRequestSchema', () => {
    it('should validate folder path', () => {
      const result = GetConfigRequestSchema.safeParse({ folderPath: 'projects' })
      expect(result.success).toBe(true)
    })
  })

  describe('SetConfigRequestSchema', () => {
    it('should validate folder path with config', () => {
      const result = SetConfigRequestSchema.safeParse({
        folderPath: 'projects',
        config: { template: 'default' }
      })
      expect(result.success).toBe(true)
    })
  })

  describe('GetViewsRequestSchema', () => {
    it('should validate folder path', () => {
      const result = GetViewsRequestSchema.safeParse({ folderPath: 'notes' })
      expect(result.success).toBe(true)
    })
  })

  describe('SetViewRequestSchema', () => {
    it('should validate folder path with view', () => {
      const result = SetViewRequestSchema.safeParse({
        folderPath: 'projects',
        view: { name: 'Active', type: 'table' }
      })
      expect(result.success).toBe(true)
    })
  })

  describe('DeleteViewRequestSchema', () => {
    it('should validate folder path with view name', () => {
      const result = DeleteViewRequestSchema.safeParse({
        folderPath: 'projects',
        viewName: 'Old View'
      })
      expect(result.success).toBe(true)
    })
  })

  describe('ListWithPropertiesRequestSchema', () => {
    it('should validate minimal request with defaults', () => {
      const result = ListWithPropertiesRequestSchema.safeParse({ folderPath: 'notes' })
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.limit).toBe(500)
        expect(result.data.offset).toBe(0)
      }
    })

    it('should validate full request', () => {
      const result = ListWithPropertiesRequestSchema.safeParse({
        folderPath: 'projects',
        properties: ['status', 'priority'],
        limit: 100,
        offset: 50
      })
      expect(result.success).toBe(true)
    })

    it('should reject limit above 1000', () => {
      const result = ListWithPropertiesRequestSchema.safeParse({
        folderPath: 'notes',
        limit: 1001
      })
      expect(result.success).toBe(false)
    })

    it('should reject negative offset', () => {
      const result = ListWithPropertiesRequestSchema.safeParse({
        folderPath: 'notes',
        offset: -1
      })
      expect(result.success).toBe(false)
    })
  })

  describe('GetAvailablePropertiesRequestSchema', () => {
    it('should validate folder path', () => {
      const result = GetAvailablePropertiesRequestSchema.safeParse({ folderPath: 'projects' })
      expect(result.success).toBe(true)
    })
  })

  describe('GetFolderSuggestionsRequestSchema', () => {
    it('should validate note id', () => {
      const result = GetFolderSuggestionsRequestSchema.safeParse({ noteId: 'note-123' })
      expect(result.success).toBe(true)
    })
  })
})

describe('Constants', () => {
  it('should have correct built-in columns', () => {
    expect(BUILT_IN_COLUMNS).toContain('title')
    expect(BUILT_IN_COLUMNS).toContain('folder')
    expect(BUILT_IN_COLUMNS).toContain('tags')
    expect(BUILT_IN_COLUMNS).toContain('created')
    expect(BUILT_IN_COLUMNS).toContain('modified')
    expect(BUILT_IN_COLUMNS).toContain('wordCount')
  })

  it('should have default columns', () => {
    expect(DEFAULT_COLUMNS).toHaveLength(4)
    expect(DEFAULT_COLUMNS.map((c) => c.id)).toEqual(['title', 'folder', 'tags', 'modified'])
  })

  it('should have valid default view', () => {
    expect(DEFAULT_VIEW.name).toBe('Default')
    expect(DEFAULT_VIEW.type).toBe('table')
    expect(DEFAULT_VIEW.default).toBe(true)
    expect(DEFAULT_VIEW.showSummaries).toBe(true)
  })
})
