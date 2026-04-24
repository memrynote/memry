import { describe, it, expect } from 'vitest'

import { propertiesRoutes } from './properties'

describe('propertiesRoutes', () => {
  it('properties_list returns all known property keys', async () => {
    const keys = (await propertiesRoutes.properties_list!(undefined)) as Array<{
      key: string
      type: string
    }>
    expect(keys.length).toBeGreaterThanOrEqual(5)
    expect(keys.every((k) => typeof k.key === 'string' && typeof k.type === 'string')).toBe(true)
  })

  it('properties_get_for_note returns the note properties map', async () => {
    const props = (await propertiesRoutes.properties_get_for_note!({
      noteId: 'note-1'
    })) as Record<string, unknown>
    expect(typeof props).toBe('object')
  })

  it('properties_set_for_note writes a value', async () => {
    await propertiesRoutes.properties_set_for_note!({
      noteId: 'note-test',
      key: 'priority',
      value: 'high'
    })
    const props = (await propertiesRoutes.properties_get_for_note!({
      noteId: 'note-test'
    })) as Record<string, unknown>
    expect(props.priority).toBe('high')
  })

  it('properties_unset_for_note removes a key', async () => {
    await propertiesRoutes.properties_set_for_note!({
      noteId: 'note-test',
      key: 'status',
      value: 'draft'
    })
    await propertiesRoutes.properties_unset_for_note!({
      noteId: 'note-test',
      key: 'status'
    })
    const props = (await propertiesRoutes.properties_get_for_note!({
      noteId: 'note-test'
    })) as Record<string, unknown>
    expect(props.status).toBeUndefined()
  })

  it('properties_distinct_values returns known values for a key', async () => {
    const values = (await propertiesRoutes.properties_distinct_values!({
      key: 'priority'
    })) as string[]
    expect(Array.isArray(values)).toBe(true)
  })
})
