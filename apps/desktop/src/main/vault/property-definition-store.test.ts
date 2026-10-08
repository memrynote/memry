import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  dataDb: { name: 'data' },
  indexDb: { name: 'index' },
  deleteCanonicalPropertyDefinition: vi.fn(),
  deletePropertyDefinitionCache: vi.fn(),
  getDatabase: vi.fn(),
  getIndexDatabase: vi.fn()
}))

vi.mock('../database', () => ({
  getDatabase: mocks.getDatabase,
  getIndexDatabase: mocks.getIndexDatabase
}))

vi.mock('@main/database/queries/notes', () => ({
  deletePropertyDefinition: mocks.deletePropertyDefinitionCache
}))

vi.mock('@memry/storage-data', () => ({
  deletePropertyDefinition: mocks.deleteCanonicalPropertyDefinition
}))

import { deletePropertyDefinitionRecord } from './property-definition-store'

describe('property-definition-store', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getDatabase.mockReturnValue(mocks.dataDb)
    mocks.getIndexDatabase.mockReturnValue(mocks.indexDb)
  })

  it('deletes canonical and cache records', () => {
    deletePropertyDefinitionRecord('Status')

    expect(mocks.deleteCanonicalPropertyDefinition).toHaveBeenCalledWith(mocks.dataDb, 'Status')
    expect(mocks.deletePropertyDefinitionCache).toHaveBeenCalledWith(mocks.indexDb, 'Status')
  })
})
