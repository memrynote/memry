import { describe, it, expect, vi, beforeEach } from 'vitest'

const updateNote = vi.fn()
const getNoteCacheById = vi.fn()
const getNotePropertiesAsRecord = vi.fn()
const syncNoteUpdate = vi.fn()
const enqueueJournalUpdate = vi.fn()
const updateJournalProperties = vi.fn()

vi.mock('../vault/notes', () => ({
  updateNote: (...args: unknown[]) => updateNote(...args)
}))
vi.mock('./store', () => ({
  getNoteCacheById: (...args: unknown[]) => getNoteCacheById(...args)
}))
vi.mock('@main/database/queries/notes', () => ({
  getNotePropertiesAsRecord: (...args: unknown[]) => getNotePropertiesAsRecord(...args)
}))
vi.mock('./runtime-effects', () => ({
  syncNoteUpdate: (...args: unknown[]) => syncNoteUpdate(...args)
}))
vi.mock('../journal/runtime-effects', () => ({
  enqueueJournalUpdate: (...args: unknown[]) => enqueueJournalUpdate(...args)
}))
vi.mock('../journal/properties', () => ({
  updateJournalProperties: (...args: unknown[]) => updateJournalProperties(...args)
}))
vi.mock('../database', () => ({ getIndexDatabase: () => ({ id: 'index-db' }) }))
vi.mock('../lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() })
}))

import { setEntityProperties, getEntityPropertiesRecord } from './entity-properties'

describe('setEntityProperties', () => {
  beforeEach(() => vi.clearAllMocks())

  it('routes a plain note to updateNote', async () => {
    getNoteCacheById.mockReturnValue({ id: 'n1', date: null })

    const result = await setEntityProperties('n1', { project: ['Alpha'] })

    expect(result).toEqual({ success: true })
    expect(updateNote).toHaveBeenCalledWith({ id: 'n1', properties: { project: ['Alpha'] } })
    expect(syncNoteUpdate).toHaveBeenCalledWith('n1')
    expect(updateJournalProperties).not.toHaveBeenCalled()
  })

  it('routes a journal entry to updateJournalProperties', async () => {
    getNoteCacheById.mockReturnValue({ id: 'j1', date: '2026-05-10' })

    const result = await setEntityProperties('j1', { Status: 'Draft' })

    expect(result).toEqual({ success: true })
    expect(updateJournalProperties).toHaveBeenCalledWith('2026-05-10', { Status: 'Draft' })
    expect(enqueueJournalUpdate).toHaveBeenCalledWith('j1', '2026-05-10')
    expect(updateNote).not.toHaveBeenCalled()
  })

  it('returns an error envelope for an unknown entity', async () => {
    getNoteCacheById.mockReturnValue(undefined)

    expect(await setEntityProperties('missing', {})).toEqual({
      success: false,
      error: 'Entity not found'
    })
    expect(updateNote).not.toHaveBeenCalled()
    expect(updateJournalProperties).not.toHaveBeenCalled()
  })
})

describe('getEntityPropertiesRecord', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns the property record for an existing entity', () => {
    getNoteCacheById.mockReturnValue({ id: 'n1', date: null })
    getNotePropertiesAsRecord.mockReturnValue({ Status: 'Draft' })

    expect(getEntityPropertiesRecord('n1')).toEqual({ Status: 'Draft' })
    expect(getNotePropertiesAsRecord).toHaveBeenCalledWith({ id: 'index-db' }, 'n1')
  })

  it('returns null for an unknown entity', () => {
    getNoteCacheById.mockReturnValue(undefined)

    expect(getEntityPropertiesRecord('missing')).toBeNull()
    expect(getNotePropertiesAsRecord).not.toHaveBeenCalled()
  })
})
