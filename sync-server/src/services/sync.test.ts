import { describe, it, expect, vi, beforeEach } from 'vitest'

import type { PushItemInput, VectorClock } from '../contracts/sync-api'
import { AppError, ErrorCodes } from '../lib/errors'

vi.mock('./blob', () => ({
  generateBlobKey: vi.fn().mockReturnValue('user-1/items/item-1'),
  putBlob: vi.fn().mockResolvedValue({ etag: 'etag-1' }),
  getBlob: vi.fn()
}))

vi.mock('./cursor', () => ({
  getNextCursor: vi.fn().mockResolvedValue(42)
}))

vi.mock('./device', () => ({
  getDevice: vi.fn()
}))

vi.mock('./user', () => ({
  getUserById: vi.fn()
}))

vi.mock('../lib/encoding', () => ({
  safeBase64Decode: vi.fn().mockImplementation((input: string) => {
    return Uint8Array.from(atob(input), (ch) => ch.charCodeAt(0))
  }),
  verifyEd25519: vi.fn().mockResolvedValue(true)
}))

vi.mock('../lib/cbor', () => ({
  encodeSignaturePayload: vi.fn().mockReturnValue(new Uint8Array([1, 2, 3]))
}))

import { safeBase64Decode, verifyEd25519 } from '../lib/encoding'

import {
  validateEncryptedFields,
  verifyItemSignature,
  detectReplay,
  computeContentHash,
  serializePayload,
  getSyncStatus,
  getManifest,
  getChanges,
  pullItems,
  updateDeviceCursor,
  processPushItem
} from './sync'
import { getDevice } from './device'
import { getUserById } from './user'
import { getBlob } from './blob'

const mockedSafeBase64Decode = vi.mocked(safeBase64Decode)
const mockedVerifyEd25519 = vi.mocked(verifyEd25519)
const mockedGetDevice = vi.mocked(getDevice)

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
  prepare: vi.fn().mockReturnValue(createMockStatement()),
  batch: vi.fn().mockResolvedValue([])
})

// ============================================================================
// Test data helpers
// ============================================================================

const createValidPushItem = (overrides?: Partial<PushItemInput>): PushItemInput => ({
  id: '550e8400-e29b-41d4-a716-446655440000',
  type: 'note',
  operation: 'create',
  encryptedKey: btoa(String.fromCharCode(...new Array(48).fill(0))),
  keyNonce: btoa(String.fromCharCode(...new Array(24).fill(0))),
  encryptedData: btoa('test-encrypted-data'),
  dataNonce: btoa(String.fromCharCode(...new Array(24).fill(0))),
  signature: btoa(String.fromCharCode(...new Array(64).fill(0))),
  signerDeviceId: 'device-1',
  clock: { 'device-1': 1 },
  ...overrides
})

// ============================================================================
// Tests: validateEncryptedFields
// ============================================================================

describe('validateEncryptedFields', () => {
  it('should pass for a valid item', () => {
    // #given
    const item = createValidPushItem()

    // #when / #then
    expect(() => validateEncryptedFields(item)).not.toThrow()
  })

  it('should throw CRYPTO_INVALID_PAYLOAD for wrong dataNonce length (23 bytes)', () => {
    // #given
    const item = createValidPushItem({
      dataNonce: btoa(String.fromCharCode(...new Array(23).fill(0)))
    })

    // #when / #then
    expect(() => validateEncryptedFields(item)).toThrow(AppError)
    try {
      validateEncryptedFields(item)
    } catch (e) {
      expect((e as AppError).code).toBe(ErrorCodes.CRYPTO_INVALID_PAYLOAD)
    }
  })

  it('should throw CRYPTO_INVALID_PAYLOAD for wrong keyNonce length', () => {
    // #given
    const item = createValidPushItem({
      keyNonce: btoa(String.fromCharCode(...new Array(23).fill(0)))
    })

    // #when / #then
    expect(() => validateEncryptedFields(item)).toThrow(AppError)
    try {
      validateEncryptedFields(item)
    } catch (e) {
      expect((e as AppError).code).toBe(ErrorCodes.CRYPTO_INVALID_PAYLOAD)
    }
  })

  it('should throw CRYPTO_INVALID_PAYLOAD for encryptedKey too short (47 bytes)', () => {
    // #given
    const item = createValidPushItem({
      encryptedKey: btoa(String.fromCharCode(...new Array(47).fill(0)))
    })

    // #when / #then
    expect(() => validateEncryptedFields(item)).toThrow(AppError)
    try {
      validateEncryptedFields(item)
    } catch (e) {
      expect((e as AppError).code).toBe(ErrorCodes.CRYPTO_INVALID_PAYLOAD)
    }
  })

  it('should throw CRYPTO_INVALID_PAYLOAD for signature wrong length (63 bytes)', () => {
    // #given
    const item = createValidPushItem({
      signature: btoa(String.fromCharCode(...new Array(63).fill(0)))
    })

    // #when / #then
    expect(() => validateEncryptedFields(item)).toThrow(AppError)
    try {
      validateEncryptedFields(item)
    } catch (e) {
      expect((e as AppError).code).toBe(ErrorCodes.CRYPTO_INVALID_PAYLOAD)
    }
  })

  it('should throw VALIDATION_ERROR for non-base64 dataNonce', () => {
    // #given
    mockedSafeBase64Decode.mockImplementationOnce(() => {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Malformed base64 input', 400)
    })
    const item = createValidPushItem({ dataNonce: '!!!not-base64!!!' })

    // #when / #then
    expect(() => validateEncryptedFields(item)).toThrow(AppError)
    try {
      mockedSafeBase64Decode.mockImplementationOnce(() => {
        throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Malformed base64 input', 400)
      })
      validateEncryptedFields(item)
    } catch (e) {
      expect((e as AppError).code).toBe(ErrorCodes.VALIDATION_ERROR)
    }
  })
})

// ============================================================================
// Tests: verifyItemSignature
// ============================================================================

describe('verifyItemSignature', () => {
  let db: ReturnType<typeof createMockDb>

  const activeDevice = {
    id: 'device-1',
    user_id: 'user-1',
    name: 'test-device',
    platform: 'darwin',
    os_version: null,
    app_version: '1.0.0',
    auth_public_key: btoa(String.fromCharCode(...new Array(32).fill(0))),
    push_token: null,
    last_sync_at: null,
    revoked_at: null,
    created_at: 1000,
    updated_at: 1000
  }

  beforeEach(() => {
    db = createMockDb()
    vi.clearAllMocks()
    mockedGetDevice.mockResolvedValue(activeDevice)
    mockedVerifyEd25519.mockResolvedValue(true)
  })

  it('should pass when signature is valid', async () => {
    // #given
    const item = createValidPushItem()

    // #when / #then
    await expect(
      verifyItemSignature(db as unknown as D1Database, item, 'user-1')
    ).resolves.toBeUndefined()
    expect(mockedVerifyEd25519).toHaveBeenCalledWith(
      activeDevice.auth_public_key,
      item.signature,
      expect.any(Uint8Array)
    )
  })

  it('should throw AUTH_DEVICE_NOT_FOUND when signer device missing', async () => {
    // #given
    mockedGetDevice.mockResolvedValue(null)
    const item = createValidPushItem()

    // #when / #then
    await expect(verifyItemSignature(db as unknown as D1Database, item, 'user-1')).rejects.toThrow(
      AppError
    )

    try {
      mockedGetDevice.mockResolvedValue(null)
      await verifyItemSignature(db as unknown as D1Database, item, 'user-1')
    } catch (e) {
      expect((e as AppError).code).toBe(ErrorCodes.AUTH_DEVICE_NOT_FOUND)
    }
  })

  it('should throw AUTH_DEVICE_REVOKED when signer device is revoked', async () => {
    // #given
    mockedGetDevice.mockResolvedValue({ ...activeDevice, revoked_at: 9999 })
    const item = createValidPushItem()

    // #when / #then
    await expect(verifyItemSignature(db as unknown as D1Database, item, 'user-1')).rejects.toThrow(
      AppError
    )

    try {
      mockedGetDevice.mockResolvedValue({ ...activeDevice, revoked_at: 9999 })
      await verifyItemSignature(db as unknown as D1Database, item, 'user-1')
    } catch (e) {
      expect((e as AppError).code).toBe(ErrorCodes.AUTH_DEVICE_REVOKED)
    }
  })

  it('should throw SYNC_INVALID_SIGNATURE when verification fails', async () => {
    // #given
    mockedVerifyEd25519.mockResolvedValueOnce(false)
    const item = createValidPushItem()

    // #when / #then
    await expect(verifyItemSignature(db as unknown as D1Database, item, 'user-1')).rejects.toThrow(
      AppError
    )

    try {
      mockedVerifyEd25519.mockResolvedValueOnce(false)
      await verifyItemSignature(db as unknown as D1Database, item, 'user-1')
    } catch (e) {
      expect((e as AppError).code).toBe(ErrorCodes.SYNC_INVALID_SIGNATURE)
    }
  })
})

// ============================================================================
// Tests: detectReplay
// ============================================================================

describe('detectReplay', () => {
  it('should return true when incoming is undefined and existing clock is present', () => {
    // #given
    const existing: VectorClock = { 'device-1': 5 }

    // #when
    const result = detectReplay(undefined, existing)

    // #then
    expect(result).toBe(true)
  })

  it('should return false when existing is undefined', () => {
    // #given
    const incoming: VectorClock = { 'device-1': 5 }

    // #when
    const result = detectReplay(incoming, undefined)

    // #then
    expect(result).toBe(false)
  })

  it('should return true when incoming equals existing (no advancement)', () => {
    // #given
    const clock: VectorClock = { 'device-1': 3, 'device-2': 2 }

    // #when
    const result = detectReplay({ ...clock }, { ...clock })

    // #then
    expect(result).toBe(true)
  })

  it('should return false when incoming advances one component', () => {
    // #given
    const incoming: VectorClock = { 'device-1': 4, 'device-2': 2 }
    const existing: VectorClock = { 'device-1': 3, 'device-2': 2 }

    // #when
    const result = detectReplay(incoming, existing)

    // #then
    expect(result).toBe(false)
  })

  it('should return true when incoming is behind existing', () => {
    // #given
    const incoming: VectorClock = { 'device-1': 2 }
    const existing: VectorClock = { 'device-1': 5 }

    // #when
    const result = detectReplay(incoming, existing)

    // #then
    expect(result).toBe(true)
  })

  it('should return false when incoming has a new key not in existing', () => {
    // #given
    const incoming: VectorClock = { 'device-1': 3, 'device-2': 1 }
    const existing: VectorClock = { 'device-1': 3 }

    // #when
    const result = detectReplay(incoming, existing)

    // #then
    expect(result).toBe(false)
  })
})

// ============================================================================
// Tests: computeContentHash
// ============================================================================

describe('computeContentHash', () => {
  it('should return consistent hex hash for same input', async () => {
    // #given
    const payload = {
      dataNonce: 'nonce-a',
      encryptedData: 'data-a',
      encryptedKey: 'key-a',
      keyNonce: 'nonce-b'
    }

    // #when
    const hash1 = await computeContentHash(payload)
    const hash2 = await computeContentHash(payload)

    // #then
    expect(hash1).toBe(hash2)
    expect(hash1).toMatch(/^[0-9a-f]{64}$/)
  })

  it('should produce different hashes for different inputs', async () => {
    // #given
    const payload1 = {
      dataNonce: 'nonce-a',
      encryptedData: 'data-a',
      encryptedKey: 'key-a',
      keyNonce: 'nonce-b'
    }
    const payload2 = {
      dataNonce: 'nonce-a',
      encryptedData: 'data-DIFFERENT',
      encryptedKey: 'key-a',
      keyNonce: 'nonce-b'
    }

    // #when
    const hash1 = await computeContentHash(payload1)
    const hash2 = await computeContentHash(payload2)

    // #then
    expect(hash1).not.toBe(hash2)
  })
})

// ============================================================================
// Tests: serializePayload
// ============================================================================

describe('serializePayload', () => {
  it('should return JSON with alphabetically sorted keys', () => {
    // #given
    const item = createValidPushItem()

    // #when
    const result = serializePayload(item)
    const parsed = JSON.parse(result) as Record<string, unknown>
    const keys = Object.keys(parsed)

    // #then
    expect(keys).toEqual(['dataNonce', 'encryptedData', 'encryptedKey', 'keyNonce'])
  })
})

// ============================================================================
// Tests: getSyncStatus
// ============================================================================

describe('getSyncStatus', () => {
  let db: ReturnType<typeof createMockDb>

  beforeEach(() => {
    db = createMockDb()
  })

  it('should return status with pending count and connected: true', async () => {
    // #given
    const deviceStmt = createMockStatement()
    deviceStmt.first.mockResolvedValue({ last_cursor_seen: 10, updated_at: 1000 })

    const countStmt = createMockStatement()
    countStmt.first.mockResolvedValue({ count: 5 })

    db.prepare.mockReturnValueOnce(deviceStmt).mockReturnValueOnce(countStmt)

    // #when
    const result = await getSyncStatus(db as unknown as D1Database, 'user-1', 'device-1')

    // #then
    expect(result.connected).toBe(true)
    expect(result.pendingItems).toBe(5)
    expect(result.lastSyncAt).toBe(1000)
    expect(result.serverTime).toBeGreaterThan(0)
  })

  it('should return 0 pending when no device state exists', async () => {
    // #given
    const deviceStmt = createMockStatement()
    deviceStmt.first.mockResolvedValue(null)

    const countStmt = createMockStatement()
    countStmt.first.mockResolvedValue({ count: 0 })

    db.prepare.mockReturnValueOnce(deviceStmt).mockReturnValueOnce(countStmt)

    // #when
    const result = await getSyncStatus(db as unknown as D1Database, 'user-1', 'device-1')

    // #then
    expect(result.pendingItems).toBe(0)
    expect(result.lastSyncAt).toBeUndefined()
  })
})

// ============================================================================
// Tests: getManifest
// ============================================================================

describe('getManifest', () => {
  let db: ReturnType<typeof createMockDb>

  beforeEach(() => {
    db = createMockDb()
  })

  it('should return items as SyncItemRef array', async () => {
    // #given
    const stmt = createMockStatement()
    stmt.all.mockResolvedValue({
      results: [
        {
          item_id: 'item-1',
          item_type: 'note',
          version: 1,
          updated_at: 1000,
          size_bytes: 512,
          state_vector: null
        }
      ]
    })
    db.prepare.mockReturnValue(stmt)

    // #when
    const result = await getManifest(db as unknown as D1Database, 'user-1')

    // #then
    expect(result.items).toEqual([
      { id: 'item-1', type: 'note', version: 1, modifiedAt: 1000, size: 512 }
    ])
    expect(result.serverTime).toBeGreaterThan(0)
  })

  it('should exclude deleted items (filtered by query)', async () => {
    // #given
    const stmt = createMockStatement()
    stmt.all.mockResolvedValue({ results: [] })
    db.prepare.mockReturnValue(stmt)

    // #when
    const result = await getManifest(db as unknown as D1Database, 'user-1')

    // #then
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('deleted_at IS NULL'))
    expect(result.items).toEqual([])
  })
})

// ============================================================================
// Tests: getChanges
// ============================================================================

describe('getChanges', () => {
  let db: ReturnType<typeof createMockDb>

  beforeEach(() => {
    db = createMockDb()
  })

  it('should return items and deleted arrays from query results', async () => {
    // #given
    const stmt = createMockStatement()
    stmt.all.mockResolvedValue({
      results: [
        {
          item_id: 'item-1',
          item_type: 'note',
          version: 1,
          updated_at: 1000,
          size_bytes: 256,
          state_vector: null,
          server_cursor: 5,
          deleted_at: null
        },
        {
          item_id: 'item-2',
          item_type: 'task',
          version: 2,
          updated_at: 2000,
          size_bytes: 128,
          state_vector: null,
          server_cursor: 6,
          deleted_at: 3000
        }
      ]
    })
    db.prepare.mockReturnValue(stmt)

    // #when
    const result = await getChanges(db as unknown as D1Database, 'user-1', 0)

    // #then
    expect(result.items).toHaveLength(1)
    expect(result.items[0].id).toBe('item-1')
    expect(result.deleted).toEqual(['item-2'])
    expect(result.nextCursor).toBe(6)
  })

  it('should set hasMore=true when rows exceed limit', async () => {
    // #given
    const rows = Array.from({ length: 3 }, (_, i) => ({
      item_id: `item-${i}`,
      item_type: 'note',
      version: 1,
      updated_at: 1000 + i,
      size_bytes: 100,
      state_vector: null,
      server_cursor: i + 1,
      deleted_at: null
    }))
    const stmt = createMockStatement()
    stmt.all.mockResolvedValue({ results: rows })
    db.prepare.mockReturnValue(stmt)

    // #when — limit=2, but we get 3 rows (limit+1 fetch pattern)
    const result = await getChanges(db as unknown as D1Database, 'user-1', 0, 2)

    // #then
    expect(result.hasMore).toBe(true)
    expect(result.items).toHaveLength(2)
  })

  it('should return empty results for cursor past all data', async () => {
    // #given
    const stmt = createMockStatement()
    stmt.all.mockResolvedValue({ results: [] })
    db.prepare.mockReturnValue(stmt)

    // #when
    const result = await getChanges(db as unknown as D1Database, 'user-1', 9999)

    // #then
    expect(result.items).toEqual([])
    expect(result.deleted).toEqual([])
    expect(result.hasMore).toBe(false)
    expect(result.nextCursor).toBe(9999)
  })
})

// ============================================================================
// Tests: pullItems
// ============================================================================

describe('pullItems', () => {
  let db: ReturnType<typeof createMockDb>

  beforeEach(() => {
    db = createMockDb()
    vi.clearAllMocks()
  })

  it('should return signer metadata, blob fields, and tombstone info', async () => {
    const stmt = createMockStatement()
    stmt.all.mockResolvedValue({
      results: [
        {
          item_id: 'item-1',
          item_type: 'task',
          blob_key: 'user-1/items/item-1',
          crypto_version: 1,
          operation: 'delete',
          signer_device_id: 'device-1',
          signature: 'sig-1',
          state_vector: 'sv-1',
          clock: '{"device-1":2}',
          deleted_at: 1700000000,
          server_cursor: 10
        }
      ]
    })
    db.prepare.mockReturnValue(stmt)
    vi.mocked(getBlob).mockResolvedValue({
      body: JSON.stringify({
        encryptedKey: 'ek',
        keyNonce: 'kn',
        encryptedData: 'ed',
        dataNonce: 'dn'
      })
    } as unknown as R2ObjectBody)

    const result = await pullItems(db as unknown as D1Database, {} as R2Bucket, 'user-1', [
      'item-1'
    ])

    expect(result).toEqual([
      {
        id: 'item-1',
        type: 'task',
        operation: 'delete',
        cryptoVersion: 1,
        signature: 'sig-1',
        signerDeviceId: 'device-1',
        deletedAt: 1700000000,
        clock: { 'device-1': 2 },
        stateVector: 'sv-1',
        blob: { encryptedKey: 'ek', keyNonce: 'kn', encryptedData: 'ed', dataNonce: 'dn' }
      }
    ])
  })

  it('should preserve original operation from storage (create stays create)', async () => {
    // #given — item stored with operation: 'create'
    const stmt = createMockStatement()
    stmt.all.mockResolvedValue({
      results: [
        {
          item_id: 'item-2',
          item_type: 'note',
          blob_key: 'user-1/items/item-2',
          crypto_version: 1,
          operation: 'create',
          signer_device_id: 'device-1',
          signature: 'sig-2',
          state_vector: null,
          clock: null,
          deleted_at: null,
          server_cursor: 5
        }
      ]
    })
    db.prepare.mockReturnValue(stmt)
    vi.mocked(getBlob).mockResolvedValue({
      body: JSON.stringify({
        encryptedKey: 'ek2',
        keyNonce: 'kn2',
        encryptedData: 'ed2',
        dataNonce: 'dn2'
      })
    } as unknown as R2ObjectBody)

    // #when
    const result = await pullItems(db as unknown as D1Database, {} as R2Bucket, 'user-1', [
      'item-2'
    ])

    // #then — operation must be 'create', not hardcoded 'update'
    expect(result[0].operation).toBe('create')
    expect(result[0].id).toBe('item-2')
  })
})

// ============================================================================
// Tests: updateDeviceCursor
// ============================================================================

describe('updateDeviceCursor', () => {
  it('should run upsert query', async () => {
    // #given
    const stmt = createMockStatement()
    const db = createMockDb()
    db.prepare.mockReturnValue(stmt)

    // #when
    await updateDeviceCursor(db as unknown as D1Database, 'device-1', 'user-1', 42)

    // #then
    expect(db.prepare).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO device_sync_state')
    )
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('ON CONFLICT'))
    expect(stmt.bind).toHaveBeenCalledWith('device-1', 'user-1', 42, expect.any(Number))
    expect(stmt.run).toHaveBeenCalled()
  })
})

// ============================================================================
// Tests: processPushItem — storage quota enforcement
// ============================================================================

describe('processPushItem', () => {
  const mockedGetDevice = vi.mocked(getDevice)
  const mockedGetUserById = vi.mocked(getUserById)

  beforeEach(() => {
    vi.clearAllMocks()
    mockedGetDevice.mockResolvedValue({
      id: 'device-1',
      user_id: 'user-1',
      device_name: 'test',
      device_type: 'desktop',
      public_key: btoa(String.fromCharCode(...new Array(32).fill(0))),
      revoked_at: null,
      last_sync_at: null,
      created_at: 1000,
      updated_at: 1000
    })
  })

  it('should reject push when storage quota would be exceeded', async () => {
    // #given — user at 99% of 1KB quota
    mockedGetUserById.mockResolvedValue({
      id: 'user-1',
      email: 'test@test.com',
      email_verified: 1,
      auth_method: 'email',
      auth_provider: null,
      auth_provider_id: null,
      kdf_salt: null,
      key_verifier: null,
      storage_used: 990,
      storage_limit: 1000,
      created_at: 1000,
      updated_at: 1000
    })

    const selectStmt = createMockStatement()
    selectStmt.first.mockResolvedValue(null)

    const db = createMockDb()
    db.prepare.mockReturnValue(selectStmt)

    const storage = {} as R2Bucket

    // #when
    const result = await processPushItem(
      db as unknown as D1Database,
      storage,
      'user-1',
      'device-1',
      createValidPushItem()
    )

    // #then
    expect(result.accepted).toBe(false)
    expect(result.reason).toBe('STORAGE_QUOTA_EXCEEDED')
  })

  it('should skip quota check when replacing item with smaller payload', async () => {
    // #given — existing item is 5000 bytes, new is smaller → sizeDelta ≤ 0
    const selectStmt = createMockStatement()
    selectStmt.first.mockResolvedValue({
      version: 1,
      clock: '{"device-1":1}',
      created_at: 1000,
      size_bytes: 50000
    })

    const upsertStmt = createMockStatement()
    const updateStmt = createMockStatement()

    const db = createMockDb()
    db.prepare
      .mockReturnValueOnce(selectStmt)
      .mockReturnValueOnce(upsertStmt)
      .mockReturnValueOnce(updateStmt)

    const storage = {
      put: vi.fn().mockResolvedValue({ etag: 'etag-1' })
    } as unknown as R2Bucket

    // #when
    const result = await processPushItem(
      db as unknown as D1Database,
      storage,
      'user-1',
      'device-1',
      createValidPushItem({ clock: { 'device-1': 2 } })
    )

    // #then — accepted without ever checking getUserById
    expect(result.accepted).toBe(true)
    expect(mockedGetUserById).not.toHaveBeenCalled()
  })

  it('should preserve existing created_at when upserting an existing row', async () => {
    const selectStmt = createMockStatement()
    selectStmt.first.mockResolvedValue({
      version: 3,
      clock: '{"device-1":3}',
      created_at: 123456,
      size_bytes: 50000
    })

    const upsertStmt = createMockStatement()
    const updateStmt = createMockStatement()
    const db = createMockDb()
    db.prepare
      .mockReturnValueOnce(selectStmt)
      .mockReturnValueOnce(upsertStmt)
      .mockReturnValueOnce(updateStmt)

    const storage = {
      put: vi.fn().mockResolvedValue({ etag: 'etag-1' })
    } as unknown as R2Bucket

    const result = await processPushItem(
      db as unknown as D1Database,
      storage,
      'user-1',
      'device-1',
      createValidPushItem({ clock: { 'device-1': 4 } })
    )

    expect(result.accepted).toBe(true)
    expect(upsertStmt.bind).toHaveBeenCalled()
    const bindArgs = upsertStmt.bind.mock.calls[0]
    expect(bindArgs[15]).toBe(123456)
  })

  it('should batch sync item upsert and storage usage update atomically', async () => {
    const selectStmt = createMockStatement()
    selectStmt.first.mockResolvedValue({
      version: 3,
      clock: '{"device-1":3}',
      created_at: 123456,
      size_bytes: 50000
    })

    const upsertStmt = createMockStatement()
    const updateStmt = createMockStatement()
    const db = createMockDb()
    db.prepare
      .mockReturnValueOnce(selectStmt)
      .mockReturnValueOnce(upsertStmt)
      .mockReturnValueOnce(updateStmt)

    const storage = {
      put: vi.fn().mockResolvedValue({ etag: 'etag-1' })
    } as unknown as R2Bucket

    const result = await processPushItem(
      db as unknown as D1Database,
      storage,
      'user-1',
      'device-1',
      createValidPushItem({ clock: { 'device-1': 4 } })
    )

    expect(result.accepted).toBe(true)
    expect(db.batch).toHaveBeenCalledTimes(1)
    expect(db.batch).toHaveBeenCalledWith([upsertStmt, updateStmt])
    expect(upsertStmt.run).not.toHaveBeenCalled()
    expect(updateStmt.run).not.toHaveBeenCalled()
  })
})
