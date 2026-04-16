/**
 * Property Types Contract Tests
 */

import { describe, it, expect } from 'vitest'
import {
  PropertyTypes,
  STATUS_CATEGORY_KEYS,
  DEFAULT_STATUS_DEFINITION,
  PropertyDefinitionSchema,
  PropertyDefinitionsFileSchema
} from './property-types'

describe('PropertyTypes', () => {
  it('exposes all property type constants', () => {
    expect(PropertyTypes).toEqual({
      TEXT: 'text',
      NUMBER: 'number',
      CHECKBOX: 'checkbox',
      DATE: 'date',
      URL: 'url',
      STATUS: 'status',
      SELECT: 'select',
      MULTISELECT: 'multiselect'
    })
  })
})

describe('STATUS_CATEGORY_KEYS', () => {
  it('exposes the expected category keys', () => {
    expect(STATUS_CATEGORY_KEYS).toEqual(['todo', 'in_progress', 'done'])
  })
})

describe('DEFAULT_STATUS_DEFINITION', () => {
  it('is a valid status property definition', () => {
    const result = PropertyDefinitionSchema.safeParse({
      type: DEFAULT_STATUS_DEFINITION.type,
      categories: DEFAULT_STATUS_DEFINITION.categories
    })
    expect(result.success).toBe(true)
  })

  it('has canonical default option marked in todo category', () => {
    const todoOption = DEFAULT_STATUS_DEFINITION.categories?.todo.options[0]
    expect(todoOption?.default).toBe(true)
    expect(todoOption?.value).toBe('Not started')
  })
})

describe('PropertyDefinitionSchema (discriminated union)', () => {
  it('accepts status variant', () => {
    const result = PropertyDefinitionSchema.safeParse({
      type: 'status',
      categories: {
        todo: { label: 'To-do', options: [{ value: 'Not started', color: 'stone' }] },
        in_progress: { label: 'In progress', options: [{ value: 'Active', color: 'amber' }] },
        done: { label: 'Done', options: [{ value: 'Complete', color: 'emerald' }] }
      }
    })
    expect(result.success).toBe(true)
  })

  it('accepts select variant', () => {
    const result = PropertyDefinitionSchema.safeParse({
      type: 'select',
      options: [
        { value: 'Low', color: 'slate' },
        { value: 'High', color: 'red', default: true }
      ]
    })
    expect(result.success).toBe(true)
  })

  it('accepts multiselect variant with empty options', () => {
    const result = PropertyDefinitionSchema.safeParse({
      type: 'multiselect',
      options: []
    })
    expect(result.success).toBe(true)
  })

  it('rejects status variant missing a category', () => {
    const result = PropertyDefinitionSchema.safeParse({
      type: 'status',
      categories: {
        todo: { label: 'To-do', options: [] },
        done: { label: 'Done', options: [] }
      }
    })
    expect(result.success).toBe(false)
  })

  it('rejects select variant missing options', () => {
    const result = PropertyDefinitionSchema.safeParse({ type: 'select' })
    expect(result.success).toBe(false)
  })

  it('rejects unknown variant type', () => {
    const result = PropertyDefinitionSchema.safeParse({ type: 'text', options: [] })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].path).toContain('type')
    }
  })

  it('rejects select option with empty value', () => {
    const result = PropertyDefinitionSchema.safeParse({
      type: 'select',
      options: [{ value: '', color: 'red' }]
    })
    expect(result.success).toBe(false)
  })

  it('rejects select option with empty color', () => {
    const result = PropertyDefinitionSchema.safeParse({
      type: 'select',
      options: [{ value: 'Low', color: '' }]
    })
    expect(result.success).toBe(false)
  })

  it('rejects status category with empty label', () => {
    const result = PropertyDefinitionSchema.safeParse({
      type: 'status',
      categories: {
        todo: { label: '', options: [] },
        in_progress: { label: 'In progress', options: [] },
        done: { label: 'Done', options: [] }
      }
    })
    expect(result.success).toBe(false)
  })
})

describe('PropertyDefinitionsFileSchema', () => {
  it('accepts empty file with default properties', () => {
    const result = PropertyDefinitionsFileSchema.safeParse({})
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.properties).toEqual({})
    }
  })

  it('accepts file with named select property', () => {
    const result = PropertyDefinitionsFileSchema.safeParse({
      properties: {
        priority: {
          type: 'select',
          options: [{ value: 'High', color: 'red' }]
        }
      }
    })
    expect(result.success).toBe(true)
  })

  it('rejects file with invalid property definition', () => {
    const result = PropertyDefinitionsFileSchema.safeParse({
      properties: {
        priority: { type: 'bogus' }
      }
    })
    expect(result.success).toBe(false)
  })
})
