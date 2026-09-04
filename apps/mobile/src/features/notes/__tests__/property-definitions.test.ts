import { describe, expect, it } from 'vitest'
import { DEFAULT_STATUS_CATEGORIES } from '@memry/contracts/property-types'

import type { VaultDb } from '@/db/index'
import { readPropertyDefinitions } from '../property-definitions'

function dbWith(rows: Array<{ id: string; payload: string | null }>): VaultDb {
  return {
    getAllAsync: async (sql: string) => {
      expect(sql).toContain("type = 'property_definition'")
      expect(sql).toContain('deleted_at IS NULL')
      return rows
    }
  } as unknown as VaultDb
}

describe('readPropertyDefinitions', () => {
  it('decodes a select definition with its option colours', async () => {
    const definitions = await readPropertyDefinitions(
      dbWith([
        {
          id: 'area',
          payload: JSON.stringify({
            name: 'area',
            type: 'select',
            options: JSON.stringify([{ value: 'Work', color: 'indigo' }])
          })
        }
      ])
    )

    expect(definitions.get('area')).toEqual({
      name: 'area',
      type: 'select',
      options: [{ value: 'Work', color: 'indigo' }]
    })
  })

  it('flattens status categories into one picker list and keeps the grouping', async () => {
    const definitions = await readPropertyDefinitions(
      dbWith([
        {
          id: 'status',
          payload: JSON.stringify({
            name: 'status',
            type: 'status',
            options: JSON.stringify({
              categories: {
                todo: { label: 'To-do', options: [{ value: 'Backlog', color: 'stone' }] },
                in_progress: { label: 'Doing', options: [{ value: 'Active', color: 'amber' }] },
                done: { label: 'Done', options: [{ value: 'Shipped', color: 'emerald' }] }
              }
            })
          })
        }
      ])
    )

    expect(definitions.get('status')?.options.map((option) => option.value)).toEqual([
      'Backlog',
      'Active',
      'Shipped'
    ])
    expect(definitions.get('status')?.categories?.todo.label).toBe('To-do')
  })

  it('falls back to the default vocabulary for a status with no categories', async () => {
    const definitions = await readPropertyDefinitions(
      dbWith([{ id: 'status', payload: JSON.stringify({ type: 'status', options: null }) }])
    )

    expect(definitions.get('status')?.categories).toEqual(DEFAULT_STATUS_CATEGORIES)
  })

  it('treats a type it does not know as text rather than crashing the row', async () => {
    // A newer desktop can define a type this build has never heard of. The
    // renderer indexes its icon table by type with no fallback, so an unknown
    // one reaching it is a crash.
    const definitions = await readPropertyDefinitions(
      dbWith([{ id: 'rating', payload: JSON.stringify({ type: 'rating' }) }])
    )

    expect(definitions.get('rating')?.type).toBe('text')
  })

  it('drops malformed options instead of the whole definition', async () => {
    const definitions = await readPropertyDefinitions(
      dbWith([
        { id: 'a', payload: JSON.stringify({ type: 'select', options: 'not json' }) },
        {
          id: 'b',
          payload: JSON.stringify({
            type: 'select',
            options: JSON.stringify([{ value: 'Ok', color: 'sky' }, { nope: true }])
          })
        }
      ])
    )

    expect(definitions.get('a')).toEqual({ name: 'a', type: 'select', options: [] })
    expect(definitions.get('b')?.options).toEqual([{ value: 'Ok', color: 'sky' }])
  })

  it('skips a row whose payload is not JSON at all', async () => {
    const definitions = await readPropertyDefinitions(
      dbWith([
        { id: 'broken', payload: '{' },
        { id: 'empty', payload: null }
      ])
    )

    expect(definitions.size).toBe(0)
  })
})
