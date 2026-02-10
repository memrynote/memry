import { beforeEach, describe, expect, it, vi } from 'vitest'

import { getDevice, listDevices, revokeDevice, updateDevice } from './device'

describe('device service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
  })

  it('lists active devices ordered by last_sync_at', async () => {
    const all = vi.fn(async () => ({
      results: [
        { id: 'device-2', last_sync_at: 200 },
        { id: 'device-1', last_sync_at: 100 }
      ]
    }))

    const bind = vi.fn(() => ({ all }))
    const prepare = vi.fn(() => ({ bind }))
    const db = { prepare } as unknown as D1Database

    const devices = await listDevices(db, 'user-1')

    expect(devices).toEqual([
      { id: 'device-2', last_sync_at: 200 },
      { id: 'device-1', last_sync_at: 100 }
    ])
    expect(prepare).toHaveBeenCalledWith(
      'SELECT * FROM devices WHERE user_id = ? AND revoked_at IS NULL ORDER BY last_sync_at DESC'
    )
  })

  it('gets a device by id and user id', async () => {
    const first = vi.fn(async () => ({ id: 'device-1', user_id: 'user-1' }))
    const bind = vi.fn(() => ({ first }))
    const prepare = vi.fn(() => ({ bind }))
    const db = { prepare } as unknown as D1Database

    await expect(getDevice(db, 'device-1', 'user-1')).resolves.toEqual({
      id: 'device-1',
      user_id: 'user-1'
    })
  })

  it('skips update when no mutable fields are provided', async () => {
    const prepare = vi.fn()
    const db = { prepare } as unknown as D1Database

    await updateDevice(db, 'device-1', {})

    expect(prepare).not.toHaveBeenCalled()
  })

  it('updates provided fields and refreshes updated_at', async () => {
    const run = vi.fn(async () => ({ success: true }))
    const bind = vi.fn(() => ({ run }))
    const prepare = vi.fn(() => ({ bind }))
    const db = { prepare } as unknown as D1Database

    await updateDevice(db, 'device-1', { name: 'Laptop', last_sync_at: 123 })

    expect(prepare).toHaveBeenCalledWith(
      'UPDATE devices SET name = ?, last_sync_at = ?, updated_at = ? WHERE id = ?'
    )
    expect(bind).toHaveBeenCalledWith('Laptop', 123, 1_700_000_000, 'device-1')
  })

  it('revokes a device using current epoch seconds', async () => {
    const run = vi.fn(async () => ({ success: true }))
    const bind = vi.fn(() => ({ run }))
    const prepare = vi.fn(() => ({ bind }))
    const db = { prepare } as unknown as D1Database

    await revokeDevice(db, 'device-1')

    expect(prepare).toHaveBeenCalledWith('UPDATE devices SET revoked_at = ? WHERE id = ?')
    expect(bind).toHaveBeenCalledWith(1_700_000_000, 'device-1')
  })
})
