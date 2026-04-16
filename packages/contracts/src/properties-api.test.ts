/**
 * Properties API Contract Tests
 */

import { describe, it, expect } from 'vitest'
import {
  GetPropertiesSchema,
  SetPropertiesSchema,
  RenamePropertySchema,
  PropertyTypes
} from './properties-api'

describe('GetPropertiesSchema', () => {
  it('accepts valid input', () => {
    const result = GetPropertiesSchema.safeParse({ entityId: 'note-1' })
    expect(result.success).toBe(true)
  })

  it('rejects empty entityId', () => {
    const result = GetPropertiesSchema.safeParse({ entityId: '' })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].path).toContain('entityId')
    }
  })

  it('rejects missing entityId', () => {
    const result = GetPropertiesSchema.safeParse({})
    expect(result.success).toBe(false)
  })
})

describe('SetPropertiesSchema', () => {
  it('accepts valid input with empty properties', () => {
    const result = SetPropertiesSchema.safeParse({
      entityId: 'note-1',
      properties: {}
    })
    expect(result.success).toBe(true)
  })

  it('accepts mixed unknown property values', () => {
    const result = SetPropertiesSchema.safeParse({
      entityId: 'note-1',
      properties: {
        status: 'Done',
        count: 3,
        tags: ['a', 'b'],
        flag: true,
        note: null
      }
    })
    expect(result.success).toBe(true)
  })

  it('rejects empty entityId', () => {
    const result = SetPropertiesSchema.safeParse({
      entityId: '',
      properties: {}
    })
    expect(result.success).toBe(false)
  })

  it('rejects missing properties', () => {
    const result = SetPropertiesSchema.safeParse({ entityId: 'note-1' })
    expect(result.success).toBe(false)
  })

  it('rejects non-object properties', () => {
    const result = SetPropertiesSchema.safeParse({
      entityId: 'note-1',
      properties: 'invalid'
    })
    expect(result.success).toBe(false)
  })
})

describe('RenamePropertySchema', () => {
  it('accepts valid input', () => {
    const result = RenamePropertySchema.safeParse({
      entityId: 'note-1',
      oldName: 'status',
      newName: 'state'
    })
    expect(result.success).toBe(true)
  })

  it('rejects empty oldName', () => {
    const result = RenamePropertySchema.safeParse({
      entityId: 'note-1',
      oldName: '',
      newName: 'state'
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].path).toContain('oldName')
    }
  })

  it('rejects empty newName', () => {
    const result = RenamePropertySchema.safeParse({
      entityId: 'note-1',
      oldName: 'status',
      newName: ''
    })
    expect(result.success).toBe(false)
  })

  it('rejects missing entityId', () => {
    const result = RenamePropertySchema.safeParse({
      oldName: 'status',
      newName: 'state'
    })
    expect(result.success).toBe(false)
  })
})

describe('PropertyTypes re-export', () => {
  it('exposes all expected property types', () => {
    expect(PropertyTypes.TEXT).toBe('text')
    expect(PropertyTypes.NUMBER).toBe('number')
    expect(PropertyTypes.CHECKBOX).toBe('checkbox')
    expect(PropertyTypes.DATE).toBe('date')
    expect(PropertyTypes.URL).toBe('url')
    expect(PropertyTypes.STATUS).toBe('status')
    expect(PropertyTypes.SELECT).toBe('select')
    expect(PropertyTypes.MULTISELECT).toBe('multiselect')
  })
})
