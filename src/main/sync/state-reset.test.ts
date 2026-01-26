/**
 * Sync State Reset Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { resetSyncStateForNewDevice } from './state-reset'

const mockDbDelete = vi.fn().mockReturnThis()
const mockDbWhere = vi.fn().mockResolvedValue(undefined)
const mockDeleteSetting = vi.fn()

vi.mock('../database', () => ({
  getDatabase: vi.fn(() => ({
    delete: mockDbDelete,
    where: mockDbWhere
  }))
}))

vi.mock('@shared/db/queries/settings', () => ({
  deleteSetting: (...args: unknown[]) => mockDeleteSetting(...args)
}))

vi.mock('@shared/db/schema/sync-schema', () => ({
  syncState: { key: 'key' }
}))

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((field, value) => ({ field, value }))
}))

describe('resetSyncStateForNewDevice', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDbDelete.mockReturnThis()
    mockDbWhere.mockResolvedValue(undefined)
  })

  it('should delete cursor from syncState', async () => {
    // #when
    await resetSyncStateForNewDevice()

    // #then
    expect(mockDbDelete).toHaveBeenCalled()
    expect(mockDbWhere).toHaveBeenCalled()
  })

  it('should delete settings field clocks from syncState', async () => {
    // #when
    await resetSyncStateForNewDevice()

    // #then
    expect(mockDbDelete).toHaveBeenCalledTimes(2)
  })

  it('should delete bootstrap flag from settings', async () => {
    // #when
    await resetSyncStateForNewDevice()

    // #then
    expect(mockDeleteSetting).toHaveBeenCalledWith(
      expect.anything(),
      'sync.bootstrap.v1'
    )
  })

  it('should handle missing database gracefully', async () => {
    // #given
    const { getDatabase } = await import('../database')
    vi.mocked(getDatabase).mockImplementationOnce(() => {
      throw new Error('No vault')
    })

    // #when / #then
    await expect(resetSyncStateForNewDevice()).resolves.not.toThrow()
  })
})
