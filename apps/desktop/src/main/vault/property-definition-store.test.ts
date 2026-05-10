import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  dataDb: { name: 'data' },
  indexDb: { name: 'index' },
  deleteCanonicalPropertyDefinition: vi.fn(),
  deletePropertyDefinitionCache: vi.fn(),
  getCanonicalPropertyDefinition: vi.fn(),
  getDatabase: vi.fn(),
  getIndexDatabase: vi.fn(),
  insertPropertyDefinitionCache: vi.fn(),
  updatePropertyDefinitionCache: vi.fn(),
  upsertPropertyDefinition: vi.fn()
}))

vi.mock('../database', () => ({
  getDatabase: mocks.getDatabase,
  getIndexDatabase: mocks.getIndexDatabase
}))

vi.mock('@main/database/queries/notes', () => ({
  deletePropertyDefinition: mocks.deletePropertyDefinitionCache,
  insertPropertyDefinition: mocks.insertPropertyDefinitionCache,
  updatePropertyDefinition: mocks.updatePropertyDefinitionCache
}))

vi.mock('@memry/storage-data', () => ({
  deletePropertyDefinition: mocks.deleteCanonicalPropertyDefinition,
  getPropertyDefinition: mocks.getCanonicalPropertyDefinition,
  upsertPropertyDefinition: mocks.upsertPropertyDefinition
}))

import {
  createPropertyDefinitionRecord,
  deletePropertyDefinitionRecord,
  updatePropertyDefinitionRecord
} from './property-definition-store'

describe('property-definition-store', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getDatabase.mockReturnValue(mocks.dataDb)
    mocks.getIndexDatabase.mockReturnValue(mocks.indexDb)
    mocks.upsertPropertyDefinition.mockImplementation((_db, definition) => ({
      createdAt: '2026-05-10T00:00:00.000Z',
      ...definition
    }))
    mocks.updatePropertyDefinitionCache.mockReturnValue(false)
  })

  it('creates canonical definitions and mirrors them into the index cache', () => {
    const definition = {
      name: 'Rating',
      type: 'number',
      options: null,
      defaultValue: '1',
      color: '#22c55e'
    }

    expect(createPropertyDefinitionRecord(definition)).toMatchObject(definition)
    expect(mocks.upsertPropertyDefinition).toHaveBeenCalledWith(mocks.dataDb, definition)
    expect(mocks.updatePropertyDefinitionCache).toHaveBeenCalledWith(mocks.indexDb, 'Rating', {
      type: 'number',
      options: null,
      defaultValue: '1',
      color: '#22c55e'
    })
    expect(mocks.insertPropertyDefinitionCache).toHaveBeenCalledWith(mocks.indexDb, definition)
  })

  it('updates existing definitions, preserves omitted fields, and skips missing definitions', () => {
    mocks.getCanonicalPropertyDefinition.mockReturnValueOnce(null)
    expect(updatePropertyDefinitionRecord('Missing', { type: 'text' })).toBeNull()

    mocks.getCanonicalPropertyDefinition.mockReturnValueOnce({
      name: 'Status',
      type: 'select',
      options: '["todo"]',
      defaultValue: 'todo',
      color: '#64748b',
      createdAt: '2026-05-01T00:00:00.000Z'
    })
    mocks.updatePropertyDefinitionCache.mockReturnValue(true)

    expect(
      updatePropertyDefinitionRecord('Status', {
        options: undefined,
        defaultValue: null,
        color: '#0ea5e9'
      })
    ).toMatchObject({
      name: 'Status',
      type: 'select',
      options: null,
      defaultValue: null,
      color: '#0ea5e9'
    })
    expect(mocks.upsertPropertyDefinition).toHaveBeenLastCalledWith(mocks.dataDb, {
      name: 'Status',
      type: 'select',
      options: null,
      defaultValue: null,
      color: '#0ea5e9'
    })
    expect(mocks.insertPropertyDefinitionCache).not.toHaveBeenCalled()
  })

  it('deletes canonical and cache records', () => {
    deletePropertyDefinitionRecord('Status')

    expect(mocks.deleteCanonicalPropertyDefinition).toHaveBeenCalledWith(mocks.dataDb, 'Status')
    expect(mocks.deletePropertyDefinitionCache).toHaveBeenCalledWith(mocks.indexDb, 'Status')
  })
})
