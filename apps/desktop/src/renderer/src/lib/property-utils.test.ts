import { describe, it, expect, vi } from 'vitest'
import {
  getDefaultValueForType,
  getUniquePropertyName,
  inferType,
  mapPropertyType
} from './property-utils'

describe('property utilities', () => {
  it('infers property types from values', () => {
    expect(inferType(true)).toBe('checkbox')
    expect(inferType(42)).toBe('number')
    expect(inferType('2026-05-12')).toBe('date')
    expect(inferType('https://memry.app')).toBe('url')
    expect(inferType('plain text')).toBe('text')
    expect(inferType(null)).toBe('text')
  })

  it('returns defaults for each property type', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-12T10:20:30.000Z'))

    expect(getDefaultValueForType('checkbox')).toBe(false)
    expect(getDefaultValueForType('number')).toBe(0)
    expect(getDefaultValueForType('date')).toBe('2026-05-12T10:20:30.000Z')
    expect(getDefaultValueForType('multiselect')).toEqual([])
    expect(getDefaultValueForType('relation')).toEqual([])
    expect(getDefaultValueForType('status')).toBeNull()
    expect(getDefaultValueForType('select')).toBeNull()
    expect(getDefaultValueForType('url')).toBe('')
    expect(getDefaultValueForType('text')).toBe('')

    vi.useRealTimers()
  })

  it('deduplicates property names with numeric suffixes', () => {
    expect(getUniquePropertyName('Status', ['Priority'])).toBe('Status')
    expect(getUniquePropertyName('Status', ['Status'])).toBe('Status 2')
    expect(getUniquePropertyName('Status', ['Status', 'Status 2', 'Status 3'])).toBe('Status 4')
  })

  it('maps backend property types and falls back to text', () => {
    expect(mapPropertyType('checkbox')).toBe('checkbox')
    expect(mapPropertyType('number')).toBe('number')
    expect(mapPropertyType('date')).toBe('date')
    expect(mapPropertyType('url')).toBe('url')
    expect(mapPropertyType('status')).toBe('status')
    expect(mapPropertyType('select')).toBe('select')
    expect(mapPropertyType('multiselect')).toBe('multiselect')
    expect(mapPropertyType('relation')).toBe('relation')
    expect(mapPropertyType('unknown')).toBe('text')
  })
})
