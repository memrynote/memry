import { describe, it, expect, vi, beforeEach } from 'vitest'

import { AppError, ErrorCodes } from '../lib/errors'

vi.mock('./auth', () => ({
  revokeDeviceTokens: vi.fn().mockResolvedValue(undefined)
}))

// ============================================================================
// D1 mock helpers
// ============================================================================

interface MockStatement {
  bind: ReturnType<typeof vi.fn>
  first: ReturnType<typeof vi.fn>
  run: ReturnType<typeof vi.fn>
  all: ReturnType<typeof vi.fn>
}

const createMockStatement = (): MockStatement => {
  const stmt: MockStatement = {
    bind: vi.fn(),
    first: vi.fn().mockResolvedValue(null),
    run: vi.fn().mockResolvedValue({ success: true }),
    all: vi.fn().mockResolvedValue({ results: [] })
  }
  stmt.bind.mockReturnValue(stmt)
  return stmt
}

const createMockDb = () => ({
  prepare: vi.fn().mockReturnValue(createMockStatement())
})

import { listDevices, getDevice, updateDevice, revokeDevice, type Device } from './device'

// ============================================================================
// Tests: listDevices
// ============================================================================

describe('listDevices', () => {
  it('should query non-revoked devices for a user', async () => {
    // #given
    const mockDevices: Device[] = [
      {
        id: 'dev-1',
        user_id: 'user-1',
        name: 'MacBook',
        platform: 'darwin',
        os_version: '14.0',
        app_version: '1.0.0',
        auth_public_key: 'pk-1',
        push_token: null,
        last_sync_at: 1000,
        revoked_at: null,
        created_at: 500,
        updated_at: 500
      }
    ]
    const stmt = createMockStatement()
    stmt.all.mockResolvedValue({ results: mockDevices })
    const db = createMockDb()
    db.prepare.mockReturnValue(stmt)

    // #when
    const result = await listDevices(db as unknown as D1Database, 'user-1')

    // #then
    expect(result).toEqual(mockDevices)
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('revoked_at IS NULL'))
    expect(stmt.bind).toHaveBeenCalledWith('user-1')
  })

  it('should return empty array when no devices exist', async () => {
    // #given
    const stmt = createMockStatement()
    stmt.all.mockResolvedValue({ results: [] })
    const db = createMockDb()
    db.prepare.mockReturnValue(stmt)

    // #when
    const result = await listDevices(db as unknown as D1Database, 'user-1')

    // #then
    expect(result).toEqual([])
  })
})

// ============================================================================
// Tests: getDevice
// ============================================================================

describe('getDevice', () => {
  it('should return a device when found', async () => {
    // #given
    const device: Device = {
      id: 'dev-1',
      user_id: 'user-1',
      name: 'MacBook',
      platform: 'darwin',
      os_version: null,
      app_version: '1.0.0',
      auth_public_key: 'pk-1',
      push_token: null,
      last_sync_at: null,
      revoked_at: null,
      created_at: 500,
      updated_at: 500
    }
    const stmt = createMockStatement()
    stmt.first.mockResolvedValue(device)
    const db = createMockDb()
    db.prepare.mockReturnValue(stmt)

    // #when
    const result = await getDevice(db as unknown as D1Database, 'dev-1', 'user-1')

    // #then
    expect(result).toEqual(device)
    expect(stmt.bind).toHaveBeenCalledWith('dev-1', 'user-1')
  })

  it('should return null when device is not found', async () => {
    // #given
    const stmt = createMockStatement()
    stmt.first.mockResolvedValue(null)
    const db = createMockDb()
    db.prepare.mockReturnValue(stmt)

    // #when
    const result = await getDevice(db as unknown as D1Database, 'nonexistent', 'user-1')

    // #then
    expect(result).toBeNull()
  })
})

// ============================================================================
// Tests: updateDevice
// ============================================================================

describe('updateDevice', () => {
  let db: ReturnType<typeof createMockDb>

  beforeEach(() => {
    db = createMockDb()
  })

  it('should update the device name', async () => {
    // #when
    await updateDevice(db as unknown as D1Database, 'dev-1', 'user-1', { name: 'New Name' })

    // #then
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('name = ?'))
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('updated_at = ?'))
  })

  it('should update last_sync_at', async () => {
    // #when
    await updateDevice(db as unknown as D1Database, 'dev-1', 'user-1', { last_sync_at: 9999 })

    // #then
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('last_sync_at = ?'))
  })

  it('should do nothing when no updates are provided', async () => {
    // #when
    await updateDevice(db as unknown as D1Database, 'dev-1', 'user-1', {})

    // #then
    const stmt = db.prepare.mock.results[0]?.value as MockStatement | undefined
    if (stmt) {
      expect(stmt.run).not.toHaveBeenCalled()
    }
  })
})

// ============================================================================
// Tests: revokeDevice
// ============================================================================

describe('revokeDevice', () => {
  it('should set revoked_at and revoke device tokens', async () => {
    // #given
    const { revokeDeviceTokens } = await import('./auth')
    const selectStmt = createMockStatement()
    selectStmt.first.mockResolvedValue({ id: 'dev-1' })

    const updateStmt = createMockStatement()

    const db = createMockDb()
    db.prepare.mockReturnValueOnce(selectStmt).mockReturnValueOnce(updateStmt)

    // #when
    await revokeDevice(db as unknown as D1Database, 'dev-1', 'user-1')

    // #then
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('SELECT id FROM devices'))
    expect(selectStmt.bind).toHaveBeenCalledWith('dev-1', 'user-1')
    expect(db.prepare).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE devices SET revoked_at')
    )
    expect(updateStmt.bind).toHaveBeenCalledWith(expect.any(Number), 'dev-1', 'user-1')
    expect(updateStmt.run).toHaveBeenCalled()
    expect(revokeDeviceTokens).toHaveBeenCalledWith(expect.anything(), 'dev-1')
  })

  it('should throw AUTH_DEVICE_NOT_FOUND when device does not exist', async () => {
    // #given
    const selectStmt = createMockStatement()
    selectStmt.first.mockResolvedValue(null)

    const db = createMockDb()
    db.prepare.mockReturnValueOnce(selectStmt)

    // #when / #then
    await expect(
      revokeDevice(db as unknown as D1Database, 'nonexistent', 'user-1')
    ).rejects.toThrow(AppError)

    try {
      await revokeDevice(db as unknown as D1Database, 'nonexistent', 'user-1')
    } catch (e) {
      expect((e as AppError).code).toBe(ErrorCodes.AUTH_DEVICE_NOT_FOUND)
      expect((e as AppError).statusCode).toBe(404)
    }
  })
})
