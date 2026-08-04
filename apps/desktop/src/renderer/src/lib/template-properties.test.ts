import { describe, expect, it } from 'vitest'

import {
  addProperty,
  removeProperty,
  reorderProperties,
  setPropertyName,
  setPropertyValue,
  toEditableProperties,
  toTemplateProperties,
  toUiProperties
} from './template-properties'

describe('template-properties', () => {
  it('round-trips every stored property type without degrading it', () => {
    const stored = [
      { name: 'Status', type: 'select' as const, value: 'todo', options: ['todo', 'done'] },
      { name: 'Tags', type: 'multiselect' as const, value: [], options: ['a'] },
      { name: 'Score', type: 'rating' as const, value: 3 },
      { name: 'Due', type: 'date' as const, value: null }
    ]

    const items = toEditableProperties(stored)
    expect(toTemplateProperties(items)).toEqual(stored)
  })

  it('preserves the stored type when a value is edited', () => {
    const items = toEditableProperties([{ name: 'Score', type: 'rating', value: 3 }])
    const edited = setPropertyValue(items, items[0].id, 5)

    expect(toTemplateProperties(edited)).toEqual([{ name: 'Score', type: 'rating', value: 5 }])
  })

  it('falls back to text for display only when the UI has no matching type', () => {
    const items = toEditableProperties([{ name: 'Score', type: 'rating', value: 3 }])

    expect(toUiProperties(items)[0].type).toBe('text')
    expect(toTemplateProperties(items)[0].type).toBe('rating')
  })

  it('displays select as select and keeps its stored options intact', () => {
    // InfoSection resolves select options from the property-definition store by
    // name, not from the Property object — so the UI shape only needs the type,
    // while the stored options must survive untouched.
    const items = toEditableProperties([
      { name: 'Status', type: 'select', value: 'todo', options: ['todo', 'done'] }
    ])

    expect(toUiProperties(items)[0].type).toBe('select')
    expect(toTemplateProperties(items)[0].options).toEqual(['todo', 'done'])
  })

  it('assigns unique stable ids', () => {
    const items = toEditableProperties([
      { name: 'A', type: 'text', value: '' },
      { name: 'B', type: 'text', value: '' }
    ])

    expect(items[0].id).not.toBe(items[1].id)
    expect(toUiProperties(items).map((p) => p.id)).toEqual(items.map((i) => i.id))
  })

  it('adds a property with a de-duplicated name and a type-appropriate default', () => {
    const items = toEditableProperties([{ name: 'Done', type: 'checkbox', value: false }])
    const next = addProperty(items, { name: 'Done', type: 'checkbox' })

    const stored = toTemplateProperties(next)
    expect(stored).toHaveLength(2)
    expect(stored[1].name).not.toBe('Done')
    expect(stored[1].value).toBe(false)
  })

  it('defaults number to 0, date to null, and text to empty string', () => {
    const items = addProperty(
      addProperty(addProperty([], { name: 'N', type: 'number' }), { name: 'D', type: 'date' }),
      { name: 'T', type: 'text' }
    )

    expect(toTemplateProperties(items).map((p) => p.value)).toEqual([0, null, ''])
  })

  it('stores a status property as select', () => {
    const items = addProperty([], { name: 'Stage', type: 'status' })

    expect(toTemplateProperties(items)[0].type).toBe('select')
  })

  it('renames without touching the type', () => {
    const items = toEditableProperties([
      { name: 'Old', type: 'select', value: 'x', options: ['x'] }
    ])
    const next = setPropertyName(items, items[0].id, 'New')

    expect(toTemplateProperties(next)).toEqual([
      { name: 'New', type: 'select', value: 'x', options: ['x'] }
    ])
  })

  it('reorders by id and survives it', () => {
    const items = toEditableProperties([
      { name: 'A', type: 'text', value: '' },
      { name: 'B', type: 'rating', value: 1 }
    ])
    const next = reorderProperties(items, [items[1].id, items[0].id])

    expect(toTemplateProperties(next).map((p) => p.name)).toEqual(['B', 'A'])
    expect(toTemplateProperties(next)[0].type).toBe('rating')
  })

  it('keeps unlisted properties when the caller reorders a subset', () => {
    const items = toEditableProperties([
      { name: 'A', type: 'text', value: '' },
      { name: 'B', type: 'text', value: '' },
      { name: 'C', type: 'text', value: '' }
    ])
    const next = reorderProperties(items, [items[2].id, items[0].id])

    expect(toTemplateProperties(next).map((p) => p.name)).toEqual(['C', 'A', 'B'])
  })

  it('removes by id', () => {
    const items = toEditableProperties([
      { name: 'A', type: 'text', value: '' },
      { name: 'B', type: 'text', value: '' }
    ])
    const next = removeProperty(items, items[0].id)

    expect(toTemplateProperties(next).map((p) => p.name)).toEqual(['B'])
  })
})
