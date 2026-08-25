import { describe, it, expect, vi, beforeEach } from 'vitest'

import type { PushItemInput, VectorClock } from '@memry/contracts/sync-api'
import { LEGACY_RECORD_SYNC_ITEM_TYPES } from '@memry/contracts/sync-api'
import { AppError, ErrorCodes } from '../lib/errors'

vi.mock('./blob', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./blob')>()),
  putBlob: vi.fn().mockResolvedValue({ etag: 'etag-1' }),
  getBlob: vi.fn()
}))

vi.mock('./cursor', () => ({
  allocateCursorRange: vi.fn()
}))

vi.mock('./quota', () => ({
  adjustStorageUsed: vi.fn().mockResolvedValue(undefined),
  checkQuota: vi.fn().mockResolvedValue(undefined),
  reserveStorage: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('./device', () => ({
  getDevice: vi.fn()
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
import { encodeSignaturePayload } from '../lib/cbor'

import {
  MAX_ENCRYPTED_DATA_BYTES,
  validateEncryptedFields,
  verifyItemSignature,
  detectReplay,
  shouldRejectRecordReplay,
  computeContentHash,
  serializePayload,
  getSyncStatus,
  getManifest,
  getChanges,
  getItem,
  pullItems,
  updateDeviceCursor,
  processRecordPushBatch,
  processPushItem
} from './sync'
import { getDevice } from './device'
import { getBlob, putBlob } from './blob'
import { adjustStorageUsed, checkQuota, reserveStorage } from './quota'
import { allocateCursorRange } from './cursor'

const mockedSafeBase64Decode = vi.mocked(safeBase64Decode)
const mockedVerifyEd25519 = vi.mocked(verifyEd25519)
const mockedGetDevice = vi.mocked(getDevice)
const mockedEncodeSignaturePayload = vi.mocked(encodeSignaturePayload)
const mockedCheckQuota = vi.mocked(checkQuota)
const mockedReserveStorage = vi.mocked(reserveStorage)
const mockedAdjustStorageUsed = vi.mocked(adjustStorageUsed)
const mockedAllocateCursorRange = vi.mocked(allocateCursorRange)

/**
 * Arms the cursor mock as an incrementing sequence: each allocation hands out
 * the next contiguous range, like the real per-user sequence row does.
 */
const armCursorSequence = (start = 42): void => {
  let next = start
  mockedAllocateCursorRange.mockImplementation(async (_db, _userId, count: number) => {
    const first = next
    next += count
    return { first, last: next - 1 }
  })
}

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
// Batched push pipeline mock helpers
// ============================================================================

interface RecordedPushStatement {
  sql: string
  binds: unknown[]
}

/**
 * D1 double for the batched push pipeline. `prepare` hands back statements
 * that record their SQL and binds; `batch` answers SELECT statements (the
 * existing-row lookup) from `options.existing` and treats everything else as a
 * write. Mirrors the crdt double's guard: more than 100 bound parameters on
 * ONE statement is a hard error, exactly as D1 answers it — the reason a
 * 100-item batch could ship green here and 500 against a real database.
 */
const createPushDb = (
  options: {
    existing?:
      Array<Record<string, unknown>> | ((binds: unknown[]) => Array<Record<string, unknown>>)
    lookupError?: unknown
    writeError?: unknown
  } = {}
) => {
  const batches: RecordedPushStatement[][] = []

  const prepare = vi.fn((sql: string) => {
    const stmt = {
      sql,
      binds: [] as unknown[],
      bind: (...args: unknown[]) => {
        if (args.length > 100) {
          throw new Error('D1_ERROR: too many SQL variables')
        }
        stmt.binds = args
        return stmt
      },
      first: vi.fn().mockResolvedValue(null),
      run: vi.fn().mockResolvedValue({ success: true }),
      all: vi.fn().mockResolvedValue({ results: [] })
    }
    return stmt
  })

  const batch = vi.fn(async (statements: Array<{ sql: string; binds: unknown[] }>) => {
    batches.push(statements.map((stmt) => ({ sql: stmt.sql, binds: stmt.binds })))
    return statements.map((stmt) => {
      if (stmt.sql.trimStart().startsWith('SELECT')) {
        if (options.lookupError) throw options.lookupError
        const rows =
          typeof options.existing === 'function'
            ? options.existing(stmt.binds)
            : (options.existing ?? [])
        return { success: true, results: rows }
      }
      if (options.writeError) throw options.writeError
      return { success: true, results: [] }
    })
  })

  return { db: { prepare, batch }, prepare, batch, batches }
}

const upsertStatements = (batches: RecordedPushStatement[][]): RecordedPushStatement[] =>
  batches.flat().filter((stmt) => stmt.sql.includes('INSERT INTO sync_items'))

const payloadBytesOf = (item: PushItemInput): number =>
  new TextEncoder().encode(serializePayload(item)).byteLength

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

  it('should throw CRYPTO_INVALID_PAYLOAD when encryptedData exceeds the byte limit', () => {
    // #given
    mockedSafeBase64Decode
      .mockImplementationOnce(() => new Uint8Array(24))
      .mockImplementationOnce(() => new Uint8Array(24))
      .mockImplementationOnce(() => new Uint8Array(48))
      .mockImplementationOnce(() => new Uint8Array(MAX_ENCRYPTED_DATA_BYTES + 1))
    const item = createValidPushItem()

    // #when / #then
    expect(() => validateEncryptedFields(item)).toThrow(AppError)
    try {
      mockedSafeBase64Decode
        .mockImplementationOnce(() => new Uint8Array(24))
        .mockImplementationOnce(() => new Uint8Array(24))
        .mockImplementationOnce(() => new Uint8Array(48))
        .mockImplementationOnce(() => new Uint8Array(MAX_ENCRYPTED_DATA_BYTES + 1))
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

  it('should include stateVector and deletedAt in the signed payload when present', async () => {
    // #given
    const item = createValidPushItem({
      clock: undefined,
      stateVector: 'state-vector-1',
      operation: 'delete',
      deletedAt: 1_700_000_001
    })

    // #when
    await verifyItemSignature(db as unknown as D1Database, item, 'user-1')

    // #then
    expect(mockedEncodeSignaturePayload).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: { stateVector: 'state-vector-1' },
        deletedAt: 1_700_000_001
      }),
      'SYNC_ITEM'
    )
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

  it('should treat missing incoming vector components as zero', () => {
    // #given
    const incoming: VectorClock = { 'device-1': undefined as unknown as number }
    const existing: VectorClock = { 'device-1': 0 }

    // #when
    const result = detectReplay(incoming, existing)

    // #then
    expect(result).toBe(true)
  })
})

describe('shouldRejectRecordReplay', () => {
  it('should not reject unsupported legacy sync item types', () => {
    expect(
      shouldRejectRecordReplay('legacy' as PushItemInput['type'], undefined, { 'device-1': 1 })
    ).toBe(false)
  })

  it('should not require clocks for settings records', () => {
    expect(shouldRejectRecordReplay('settings', undefined, { 'device-1': 1 })).toBe(false)
  })

  it('should reject clock-required records when the incoming clock is not newer', () => {
    expect(shouldRejectRecordReplay('note', { 'device-1': 1 }, { 'device-1': 1 })).toBe(true)
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

  it('should return 0 pending when the count row is missing', async () => {
    // #given
    const deviceStmt = createMockStatement()
    deviceStmt.first.mockResolvedValue({ last_cursor_seen: 10, updated_at: 1000 })

    const countStmt = createMockStatement()
    countStmt.first.mockResolvedValue(null)

    db.prepare.mockReturnValueOnce(deviceStmt).mockReturnValueOnce(countStmt)

    // #when
    const result = await getSyncStatus(db as unknown as D1Database, 'user-1', 'device-1')

    // #then
    expect(result.pendingItems).toBe(0)
    expect(result.lastSyncAt).toBe(1000)
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

  it('should filter manifest rows by vault id', async () => {
    const stmt = createMockStatement()
    stmt.all.mockResolvedValue({ results: [] })
    db.prepare.mockReturnValue(stmt)

    await getManifest(db as unknown as D1Database, 'user-1', 'vault-2')

    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('vault_id = ?'))
    expect(stmt.bind.mock.calls[0][1]).toBe('vault-2')
  })

  it('should keep manifest responses record-only and strip record stateVector metadata', async () => {
    // #given
    const stmt = createMockStatement()
    stmt.all.mockResolvedValue({
      results: [
        {
          item_id: 'item-note',
          item_type: 'note',
          version: 1,
          updated_at: 1000,
          size_bytes: 512,
          state_vector: 'legacy-note-state'
        },
        {
          item_id: 'item-attachment',
          item_type: 'attachment',
          version: 1,
          updated_at: 1001,
          size_bytes: 128,
          state_vector: 'attachment-state'
        }
      ]
    })
    db.prepare.mockReturnValue(stmt)

    // #when
    const result = await getManifest(db as unknown as D1Database, 'user-1')

    // #then
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('item_type IN'))
    expect(result.items).toEqual([
      { id: 'item-note', type: 'note', version: 1, modifiedAt: 1000, size: 512 }
    ])
  })

  it('should tolerate D1 returning no results array', async () => {
    // #given
    const stmt = createMockStatement()
    stmt.all.mockResolvedValue({})
    db.prepare.mockReturnValue(stmt)

    // #when
    const result = await getManifest(db as unknown as D1Database, 'user-1')

    // #then
    expect(result.items).toEqual([])
  })

  it('should ignore unsupported manifest rows returned by D1', async () => {
    // #given
    const stmt = createMockStatement()
    stmt.all.mockResolvedValue({
      results: [
        {
          item_id: 'legacy-1',
          item_type: 'legacy',
          version: 1,
          updated_at: 1000,
          size_bytes: 1,
          state_vector: null
        }
      ]
    })
    db.prepare.mockReturnValue(stmt)

    // #when
    const result = await getManifest(db as unknown as D1Database, 'user-1')

    // #then
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

  it('should keep change feeds record-only and omit record stateVector metadata', async () => {
    // #given
    const stmt = createMockStatement()
    stmt.all.mockResolvedValue({
      results: [
        {
          item_id: 'item-note',
          item_type: 'note',
          version: 1,
          updated_at: 1000,
          size_bytes: 256,
          state_vector: 'legacy-note-state',
          server_cursor: 5,
          deleted_at: null
        },
        {
          item_id: 'item-attachment',
          item_type: 'attachment',
          version: 2,
          updated_at: 2000,
          size_bytes: 128,
          state_vector: 'attachment-state',
          server_cursor: 6,
          deleted_at: 3000
        }
      ]
    })
    db.prepare.mockReturnValue(stmt)

    // #when
    const result = await getChanges(db as unknown as D1Database, 'user-1', 0)

    // #then
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('item_type IN'))
    expect(result).toEqual({
      items: [{ id: 'item-note', type: 'note', version: 1, modifiedAt: 1000, size: 256 }],
      deleted: [],
      hasMore: false,
      nextCursor: 6
    })
  })

  it('should cap the requested changes limit at the service maximum', async () => {
    // #given
    const stmt = createMockStatement()
    stmt.all.mockResolvedValue({ results: [] })
    db.prepare.mockReturnValue(stmt)

    // #when
    await getChanges(db as unknown as D1Database, 'user-1', 10, 9999)

    // #then
    const bindArgs = stmt.bind.mock.calls[0]
    expect(bindArgs.at(-1)).toBe(501)
  })

  it('should ignore unsupported rows returned by D1', async () => {
    // #given
    const stmt = createMockStatement()
    stmt.all.mockResolvedValue({
      results: [
        {
          item_id: 'legacy-1',
          item_type: 'legacy',
          version: 1,
          updated_at: 1000,
          size_bytes: 256,
          state_vector: null,
          server_cursor: 5,
          deleted_at: null
        }
      ]
    })
    db.prepare.mockReturnValue(stmt)

    // #when
    const result = await getChanges(db as unknown as D1Database, 'user-1', 0)

    // #then
    expect(result.items).toEqual([])
    expect(result.deleted).toEqual([])
    expect(result.nextCursor).toBe(5)
  })

  it('should tolerate D1 returning no changes results array', async () => {
    // #given
    const stmt = createMockStatement()
    stmt.all.mockResolvedValue({})
    db.prepare.mockReturnValue(stmt)

    // #when
    const result = await getChanges(db as unknown as D1Database, 'user-1', 7)

    // #then
    expect(result).toEqual({ items: [], deleted: [], hasMore: false, nextCursor: 7 })
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
          blob_key: 'user-1/vaults/default/items/item-1',
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
          blob_key: 'user-1/vaults/default/items/item-2',
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

  it('should keep pull responses record-only and omit stateVector metadata', async () => {
    const stmt = createMockStatement()
    stmt.all.mockResolvedValue({
      results: [
        {
          item_id: 'item-note',
          item_type: 'note',
          blob_key: 'user-1/vaults/default/items/item-note',
          crypto_version: 1,
          operation: 'update',
          signer_device_id: 'device-1',
          signature: 'sig-note',
          state_vector: 'legacy-note-state',
          clock: '{"device-1":3}',
          deleted_at: null,
          server_cursor: 10
        },
        {
          item_id: 'item-attachment',
          item_type: 'attachment',
          blob_key: 'user-1/vaults/default/items/item-attachment',
          crypto_version: 1,
          operation: 'update',
          signer_device_id: 'device-1',
          signature: 'sig-attachment',
          state_vector: 'attachment-state',
          clock: null,
          deleted_at: null,
          server_cursor: 11
        }
      ]
    })
    db.prepare.mockReturnValue(stmt)
    vi.mocked(getBlob).mockResolvedValue({
      body: JSON.stringify({
        encryptedKey: 'ek-note',
        keyNonce: 'kn-note',
        encryptedData: 'ed-note',
        dataNonce: 'dn-note'
      })
    } as unknown as R2ObjectBody)

    const result = await pullItems(db as unknown as D1Database, {} as R2Bucket, 'user-1', [
      'item-note',
      'item-attachment'
    ])

    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('item_type IN'))
    expect(result).toEqual([
      {
        id: 'item-note',
        type: 'note',
        operation: 'update',
        cryptoVersion: 1,
        signature: 'sig-note',
        signerDeviceId: 'device-1',
        clock: { 'device-1': 3 },
        blob: {
          encryptedKey: 'ek-note',
          keyNonce: 'kn-note',
          encryptedData: 'ed-note',
          dataNonce: 'dn-note'
        }
      }
    ])
  })

  it('should return an empty array without querying D1 for empty pulls', async () => {
    const result = await pullItems(db as unknown as D1Database, {} as R2Bucket, 'user-1', [])

    expect(result).toEqual([])
    expect(db.prepare).not.toHaveBeenCalled()
  })

  it('should sort multi-batch pull results by server cursor', async () => {
    // #given
    const firstStmt = createMockStatement()
    firstStmt.all.mockResolvedValue({
      results: [
        {
          item_id: 'item-90',
          item_type: 'note',
          blob_key: 'blob-90',
          crypto_version: 1,
          operation: 'update',
          signer_device_id: 'device-1',
          signature: 'sig-90',
          state_vector: null,
          clock: null,
          deleted_at: null,
          server_cursor: 90
        }
      ]
    })
    const secondStmt = createMockStatement()
    secondStmt.all.mockResolvedValue({
      results: [
        {
          item_id: 'item-10',
          item_type: 'note',
          blob_key: 'blob-10',
          crypto_version: 1,
          operation: 'update',
          signer_device_id: 'device-1',
          signature: 'sig-10',
          state_vector: null,
          clock: null,
          deleted_at: null,
          server_cursor: 10
        }
      ]
    })
    db.prepare.mockReturnValueOnce(firstStmt).mockReturnValueOnce(secondStmt)
    vi.mocked(getBlob).mockResolvedValue({
      body: JSON.stringify({
        encryptedKey: 'ek',
        keyNonce: 'kn',
        encryptedData: 'ed',
        dataNonce: 'dn'
      })
    } as unknown as R2ObjectBody)

    // #when
    const result = await pullItems(
      db as unknown as D1Database,
      {} as R2Bucket,
      'user-1',
      Array.from({ length: 100 }, (_, index) => `item-${index}`)
    )

    // #then
    expect(result.map((item) => item.id)).toEqual(['item-10', 'item-90'])
  })

  it('should size batches off the negotiated types.length, not RECORD_SYNC_ITEM_TYPES.length', async () => {
    // #given — negotiate down to a single type so BATCH_SIZE = 95 - 2 - 1 = 92.
    // 160 itemIds is chosen so the two possible implementations diverge: the
    // correct code batches ceil(160 / 92) = 2 times (92 + 68). If BATCH_SIZE
    // regressed to use RECORD_SYNC_ITEM_TYPES.length (15) instead of
    // types.length, it would compute 95 - 2 - 15 = 78 and batch
    // ceil(160 / 78) = 3 times (78 + 78 + 4) instead. 2 vs 3 prepare calls
    // makes the regression observable.
    const itemIds = Array.from({ length: 160 }, (_, index) => `item-${index}`)

    // #when
    await pullItems(db as unknown as D1Database, {} as R2Bucket, 'user-1', itemIds, 'default', [
      'note'
    ])

    // #then
    expect(db.prepare).toHaveBeenCalledTimes(2)
  })

  it('should reject stored rows missing signer metadata', async () => {
    // #given
    const stmt = createMockStatement()
    stmt.all.mockResolvedValue({
      results: [
        {
          item_id: 'item-1',
          item_type: 'note',
          blob_key: 'blob-1',
          crypto_version: 1,
          operation: 'update',
          signer_device_id: null,
          signature: 'sig-1',
          state_vector: null,
          clock: null,
          deleted_at: null,
          server_cursor: 1
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

    // #when / #then
    await expect(
      pullItems(db as unknown as D1Database, {} as R2Bucket, 'user-1', ['item-1'])
    ).rejects.toMatchObject({ code: ErrorCodes.INTERNAL_ERROR })
  })

  it('should skip missing blobs but still reject corrupt blob payloads', async () => {
    // #given — a missing object costs only its own row (a dangling row must
    // not wedge every pull page), while corruption stays loud: bytes that
    // exist but cannot be parsed mean something is actively wrong.
    const row = {
      item_id: 'item-1',
      item_type: 'note',
      blob_key: 'blob-1',
      crypto_version: 1,
      operation: 'update',
      signer_device_id: 'device-1',
      signature: 'sig-1',
      state_vector: null,
      clock: null,
      deleted_at: null,
      server_cursor: 1
    }
    const stmt = createMockStatement()
    stmt.all.mockResolvedValue({ results: [row] })
    db.prepare.mockReturnValue(stmt)
    vi.mocked(getBlob).mockResolvedValueOnce(null)

    // #when / #then
    await expect(
      pullItems(db as unknown as D1Database, {} as R2Bucket, 'user-1', ['item-1'])
    ).resolves.toEqual([])

    const corruptStmt = createMockStatement()
    corruptStmt.all.mockResolvedValue({ results: [row] })
    db.prepare.mockReturnValue(corruptStmt)
    vi.mocked(getBlob).mockResolvedValueOnce({ body: '{' } as unknown as R2ObjectBody)

    await expect(
      pullItems(db as unknown as D1Database, {} as R2Bucket, 'user-1', ['item-1'])
    ).rejects.toMatchObject({ code: ErrorCodes.INTERNAL_ERROR })
  })

  it('should reject corrupt stored clocks', async () => {
    // #given
    const stmt = createMockStatement()
    stmt.all.mockResolvedValue({
      results: [
        {
          item_id: 'item-1',
          item_type: 'note',
          blob_key: 'blob-1',
          crypto_version: 1,
          operation: 'update',
          signer_device_id: 'device-1',
          signature: 'sig-1',
          state_vector: null,
          clock: '{',
          deleted_at: null,
          server_cursor: 1
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

    // #when / #then
    await expect(
      pullItems(db as unknown as D1Database, {} as R2Bucket, 'user-1', ['item-1'])
    ).rejects.toMatchObject({ code: ErrorCodes.INTERNAL_ERROR })
  })

  it('should tolerate D1 returning no pull results array', async () => {
    // #given
    const stmt = createMockStatement()
    stmt.all.mockResolvedValue({})
    db.prepare.mockReturnValue(stmt)

    // #when
    const result = await pullItems(db as unknown as D1Database, {} as R2Bucket, 'user-1', [
      'item-1'
    ])

    // #then
    expect(result).toEqual([])
  })

  it('should preserve server_cursor order across concurrency windows', async () => {
    // #given — more rows than the concurrency window so reads span >1 window
    const ROW_COUNT = 30
    const stmt = createMockStatement()
    stmt.all.mockResolvedValue({
      results: Array.from({ length: ROW_COUNT }, (_, index) => ({
        item_id: `item-${index}`,
        item_type: 'note',
        blob_key: `blob-${index}`,
        crypto_version: 1,
        operation: 'update',
        signer_device_id: 'device-1',
        signature: `sig-${index}`,
        state_vector: null,
        clock: null,
        deleted_at: null,
        server_cursor: index
      }))
    })
    db.prepare.mockReturnValue(stmt)
    // Resolve earlier blob keys later so completion order is roughly the reverse
    // of input order; windowed Promise.all must still return server_cursor order.
    vi.mocked(getBlob).mockImplementation(async (_storage, blobKey) => {
      const index = Number(blobKey.split('-')[1])
      await new Promise((resolve) => setTimeout(resolve, (ROW_COUNT - index) % 5))
      return {
        body: JSON.stringify({
          encryptedKey: 'ek',
          keyNonce: 'kn',
          encryptedData: 'ed',
          dataNonce: 'dn'
        })
      } as unknown as R2ObjectBody
    })

    // #when
    const result = await pullItems(
      db as unknown as D1Database,
      {} as R2Bucket,
      'user-1',
      Array.from({ length: ROW_COUNT }, (_, index) => `item-${index}`)
    )

    // #then
    expect(result.map((item) => item.id)).toEqual(
      Array.from({ length: ROW_COUNT }, (_, index) => `item-${index}`)
    )
  })

  it('should filter out unsupported item types while preserving order of the rest', async () => {
    // #given — a middle row whose type is not a supported record type
    const stmt = createMockStatement()
    stmt.all.mockResolvedValue({
      results: [
        {
          item_id: 'item-a',
          item_type: 'note',
          blob_key: 'blob-a',
          crypto_version: 1,
          operation: 'update',
          signer_device_id: 'device-1',
          signature: 'sig-a',
          state_vector: null,
          clock: null,
          deleted_at: null,
          server_cursor: 1
        },
        {
          item_id: 'item-skip',
          item_type: 'legacy_unsupported',
          blob_key: 'blob-skip',
          crypto_version: 1,
          operation: 'update',
          signer_device_id: 'device-1',
          signature: 'sig-skip',
          state_vector: null,
          clock: null,
          deleted_at: null,
          server_cursor: 2
        },
        {
          item_id: 'item-b',
          item_type: 'task',
          blob_key: 'blob-b',
          crypto_version: 1,
          operation: 'update',
          signer_device_id: 'device-1',
          signature: 'sig-b',
          state_vector: null,
          clock: null,
          deleted_at: null,
          server_cursor: 3
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

    // #when
    const result = await pullItems(db as unknown as D1Database, {} as R2Bucket, 'user-1', [
      'item-a',
      'item-skip',
      'item-b'
    ])

    // #then — the unsupported row is dropped, surviving rows keep their order
    expect(result.map((item) => item.id)).toEqual(['item-a', 'item-b'])
  })

  it('should bound concurrent R2 reads to the window size', async () => {
    // #given — mirrors R2_CONCURRENCY in sync.ts; rows span more than one window
    const R2_CONCURRENCY = 25
    const ROW_COUNT = R2_CONCURRENCY + 10
    const stmt = createMockStatement()
    stmt.all.mockResolvedValue({
      results: Array.from({ length: ROW_COUNT }, (_, index) => ({
        item_id: `item-${index}`,
        item_type: 'note',
        blob_key: `blob-${index}`,
        crypto_version: 1,
        operation: 'update',
        signer_device_id: 'device-1',
        signature: `sig-${index}`,
        state_vector: null,
        clock: null,
        deleted_at: null,
        server_cursor: index
      }))
    })
    db.prepare.mockReturnValue(stmt)
    let inFlight = 0
    let peak = 0
    vi.mocked(getBlob).mockImplementation(async () => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 0))
      inFlight -= 1
      return {
        body: JSON.stringify({
          encryptedKey: 'ek',
          keyNonce: 'kn',
          encryptedData: 'ed',
          dataNonce: 'dn'
        })
      } as unknown as R2ObjectBody
    })

    // #when
    const result = await pullItems(
      db as unknown as D1Database,
      {} as R2Bucket,
      'user-1',
      Array.from({ length: ROW_COUNT }, (_, index) => `item-${index}`)
    )

    // #then — reads overlapped (not serial) but never exceeded the bound
    expect(result).toHaveLength(ROW_COUNT)
    expect(peak).toBeGreaterThan(1)
    expect(peak).toBeLessThanOrEqual(R2_CONCURRENCY)
  })
})

describe('getItem', () => {
  let db: ReturnType<typeof createMockDb>

  beforeEach(() => {
    db = createMockDb()
    vi.clearAllMocks()
  })

  it('should return a single item payload', async () => {
    // #given
    const stmt = createMockStatement()
    stmt.first.mockResolvedValue({
      item_id: 'item-1',
      item_type: 'note',
      version: 2,
      blob_key: 'blob-1',
      server_cursor: 11
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

    // #when
    const result = await getItem(db as unknown as D1Database, {} as R2Bucket, 'user-1', 'item-1')

    // #then
    expect(result).toEqual({
      itemId: 'item-1',
      type: 'note',
      version: 2,
      payload: { encryptedKey: 'ek', keyNonce: 'kn', encryptedData: 'ed', dataNonce: 'dn' },
      serverCursor: 11
    })
  })

  it('should reject missing items', async () => {
    // #given
    const stmt = createMockStatement()
    stmt.first.mockResolvedValue(null)
    db.prepare.mockReturnValue(stmt)

    // #when / #then
    await expect(
      getItem(db as unknown as D1Database, {} as R2Bucket, 'user-1', 'missing')
    ).rejects.toMatchObject({ code: ErrorCodes.SYNC_ITEM_NOT_FOUND })
  })
})

describe('processRecordPushBatch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    armCursorSequence(42)
    mockedCheckQuota.mockResolvedValue(undefined)
    mockedReserveStorage.mockResolvedValue(undefined)
    mockedAdjustStorageUsed.mockResolvedValue(undefined)
    mockedVerifyEd25519.mockResolvedValue(true)
    vi.mocked(putBlob).mockResolvedValue({ etag: 'etag-1' } as unknown as R2Object)
    mockedGetDevice.mockResolvedValue({
      id: 'device-1',
      user_id: 'user-1',
      name: 'test',
      platform: 'desktop',
      os_version: null,
      app_version: '1.0.0',
      auth_public_key: btoa(String.fromCharCode(...new Array(32).fill(0))),
      push_token: null,
      revoked_at: null,
      last_sync_at: null,
      created_at: 1000,
      updated_at: 1000
    })
  })

  it('should aggregate accepted and rejected item outcomes', async () => {
    // #given
    const { db } = createPushDb({
      existing: [
        {
          item_type: 'note',
          item_id: 'item-b',
          version: 1,
          clock: '{"device-1":3}',
          size_bytes: 100,
          created_at: 1000
        }
      ]
    })

    // #when
    const result = await processRecordPushBatch(
      db as unknown as D1Database,
      {} as R2Bucket,
      'user-1',
      'device-1',
      [
        createValidPushItem({ id: 'item-a' }),
        createValidPushItem({ id: 'item-b', clock: { 'device-1': 2 } })
      ]
    )

    // #then
    expect(mockedCheckQuota).toHaveBeenCalled()
    expect(result.accepted).toEqual(['item-a'])
    expect(result.rejected).toEqual([{ id: 'item-b', reason: 'SYNC_REPLAY_DETECTED' }])
    expect(result.maxCursor).toBe(42)
    expect(result.outcomes).toEqual([
      {
        id: 'item-a',
        type: 'note',
        accepted: true,
        reason: undefined,
        serverCursor: 42
      },
      {
        id: 'item-b',
        type: 'note',
        accepted: false,
        reason: 'SYNC_REPLAY_DETECTED',
        serverCursor: undefined
      }
    ])
  })

  it('should keep maxCursor at zero when accepted items do not return cursors', async () => {
    // #given
    mockedAllocateCursorRange.mockResolvedValueOnce({ first: 0, last: 0 })
    const { db } = createPushDb()

    // #when
    const result = await processRecordPushBatch(
      db as unknown as D1Database,
      {} as R2Bucket,
      'user-1',
      'device-1',
      [createValidPushItem({ id: 'item-a' })]
    )

    // #then
    expect(result.accepted).toEqual(['item-a'])
    expect(result.maxCursor).toBe(0)
  })

  it('should allocate ONE contiguous cursor range and assign it in item order', async () => {
    // #given
    const { db } = createPushDb()
    const items = [
      createValidPushItem({ id: 'item-a' }),
      createValidPushItem({ id: 'item-b' }),
      createValidPushItem({ id: 'item-c' })
    ]

    // #when
    const result = await processRecordPushBatch(
      db as unknown as D1Database,
      {} as R2Bucket,
      'user-1',
      'device-1',
      items
    )

    // #then — one allocation for the whole batch, not one per item
    expect(mockedAllocateCursorRange).toHaveBeenCalledTimes(1)
    expect(mockedAllocateCursorRange).toHaveBeenCalledWith(db, 'user-1', 3)
    expect(result.outcomes.map((outcome) => outcome.serverCursor)).toEqual([42, 43, 44])
    expect(result.maxCursor).toBe(44)
  })

  it('should split the existing-row lookup at the D1 bind-param ceiling for a 100-item batch', async () => {
    // #given
    const { db, batches } = createPushDb()
    const items = Array.from({ length: 100 }, (_, i) =>
      createValidPushItem({ id: `item-${String(i).padStart(3, '0')}` })
    )

    // #when
    const result = await processRecordPushBatch(
      db as unknown as D1Database,
      {} as R2Bucket,
      'user-1',
      'device-1',
      items
    )

    // #then — every item lands, cursors stay contiguous in item order
    expect(result.accepted).toHaveLength(100)
    expect(result.outcomes.map((outcome) => outcome.serverCursor)).toEqual(
      Array.from({ length: 100 }, (_, i) => 42 + i)
    )

    // #and the lookup went out as ONE db.batch of ceiling-sized SELECT chunks
    const lookupBatch = batches[0]
    expect(lookupBatch.every((stmt) => stmt.sql.trimStart().startsWith('SELECT'))).toBe(true)
    expect(lookupBatch.map((stmt) => stmt.binds.length)).toEqual([95, 9])

    // #and all 100 upserts went out as one write batch
    expect(upsertStatements(batches)).toHaveLength(100)
    expect(db.batch).toHaveBeenCalledTimes(2)
  })

  it('should fetch the signer device once per unique signer, not once per item', async () => {
    // #given
    mockedGetDevice.mockImplementation(async (_db, deviceId: string) => ({
      id: deviceId,
      user_id: 'user-1',
      name: 'test',
      platform: 'desktop',
      os_version: null,
      app_version: '1.0.0',
      auth_public_key: btoa(String.fromCharCode(...new Array(32).fill(0))),
      push_token: null,
      revoked_at: null,
      last_sync_at: null,
      created_at: 1000,
      updated_at: 1000
    }))
    const { db } = createPushDb()

    // #when
    const result = await processRecordPushBatch(
      db as unknown as D1Database,
      {} as R2Bucket,
      'user-1',
      'device-1',
      [
        createValidPushItem({ id: 'item-a' }),
        createValidPushItem({ id: 'item-b' }),
        createValidPushItem({ id: 'item-c', signerDeviceId: 'device-2', clock: { 'device-2': 1 } })
      ]
    )

    // #then
    expect(result.accepted).toHaveLength(3)
    expect(mockedGetDevice).toHaveBeenCalledTimes(2)
    expect(mockedGetDevice).toHaveBeenCalledWith(db, 'device-1', 'user-1')
    expect(mockedGetDevice).toHaveBeenCalledWith(db, 'device-2', 'user-1')
  })

  it('should reject every item with INTERNAL_ERROR when the device lookup itself fails', async () => {
    // #given — an infrastructure error from the device read, not a "not found"
    mockedGetDevice.mockRejectedValueOnce(new Error('D1 unavailable'))
    const { db } = createPushDb()
    const items = [createValidPushItem({ id: 'item-a' }), createValidPushItem({ id: 'item-b' })]

    // #when
    const result = await processRecordPushBatch(
      db as unknown as D1Database,
      {} as R2Bucket,
      'user-1',
      'device-1',
      items
    )

    // #then — one INTERNAL_ERROR rejection per item, exactly what the serial
    // loop's per-item catch produced; the batch never throws
    expect(result.accepted).toEqual([])
    expect(result.rejected).toEqual([
      { id: 'item-a', reason: 'INTERNAL_ERROR' },
      { id: 'item-b', reason: 'INTERNAL_ERROR' }
    ])
    expect(mockedAllocateCursorRange).not.toHaveBeenCalled()
  })

  it('should reserve storage ONCE with the summed growth of the batch', async () => {
    // #given
    const { db } = createPushDb()
    const items = [
      createValidPushItem({ id: 'item-a' }),
      createValidPushItem({ id: 'item-b' }),
      createValidPushItem({ id: 'item-c' })
    ]
    const totalBytes = items.reduce((sum, item) => sum + payloadBytesOf(item), 0)

    // #when
    await processRecordPushBatch(
      db as unknown as D1Database,
      {} as R2Bucket,
      'user-1',
      'device-1',
      items
    )

    // #then
    expect(mockedReserveStorage).toHaveBeenCalledTimes(1)
    expect(mockedReserveStorage).toHaveBeenCalledWith(db, 'user-1', totalBytes)
  })

  it('should fall back to per-item reservation on quota breach so outcomes match the serial code', async () => {
    // #given — the summed reservation fails, then per item: a fits, b does not, c fits
    const quotaError = new AppError(
      ErrorCodes.STORAGE_QUOTA_EXCEEDED,
      'Storage quota exceeded',
      413
    )
    mockedReserveStorage
      .mockRejectedValueOnce(quotaError)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(quotaError)
      .mockResolvedValueOnce(undefined)
    const { db } = createPushDb()

    // #when
    const result = await processRecordPushBatch(
      db as unknown as D1Database,
      {} as R2Bucket,
      'user-1',
      'device-1',
      [
        createValidPushItem({ id: 'item-a' }),
        createValidPushItem({ id: 'item-b' }),
        createValidPushItem({ id: 'item-c' })
      ]
    )

    // #then — exactly the per-item outcomes the old serial loop produced
    expect(result.accepted).toEqual(['item-a', 'item-c'])
    expect(result.rejected).toEqual([{ id: 'item-b', reason: 'STORAGE_QUOTA_EXCEEDED' }])
    expect(mockedAllocateCursorRange).toHaveBeenCalledWith(db, 'user-1', 2)
    expect(result.outcomes.map((outcome) => outcome.serverCursor)).toEqual([42, undefined, 43])
  })

  it('should reject only the item whose R2 put failed and refund its reservation', async () => {
    // #given
    vi.mocked(putBlob).mockImplementation(async (_storage, key: string) => {
      if (key.includes('item-b')) {
        throw new AppError(ErrorCodes.STORAGE_UPLOAD_FAILED, 'Blob upload failed', 500)
      }
      return { etag: 'etag-1' } as unknown as R2Object
    })
    const { db } = createPushDb()
    const items = [
      createValidPushItem({ id: 'item-a' }),
      createValidPushItem({ id: 'item-b' }),
      createValidPushItem({ id: 'item-c' })
    ]

    // #when
    const result = await processRecordPushBatch(
      db as unknown as D1Database,
      {} as R2Bucket,
      'user-1',
      'device-1',
      items
    )

    // #then
    expect(result.accepted).toEqual(['item-a', 'item-c'])
    expect(result.rejected).toEqual([{ id: 'item-b', reason: 'STORAGE_UPLOAD_FAILED' }])
    expect(mockedAllocateCursorRange).toHaveBeenCalledWith(db, 'user-1', 2)
    expect(mockedAdjustStorageUsed).toHaveBeenCalledWith(db, 'user-1', -payloadBytesOf(items[1]))
  })

  it('should reject every item of a failed write batch and refund the whole reservation', async () => {
    // #given
    const { db } = createPushDb({ writeError: new Error('D1_ERROR: Network connection lost.') })
    const items = [createValidPushItem({ id: 'item-a' }), createValidPushItem({ id: 'item-b' })]
    const totalBytes = items.reduce((sum, item) => sum + payloadBytesOf(item), 0)

    // #when
    const result = await processRecordPushBatch(
      db as unknown as D1Database,
      {} as R2Bucket,
      'user-1',
      'device-1',
      items
    )

    // #then
    expect(result.accepted).toEqual([])
    expect(result.rejected).toEqual([
      { id: 'item-a', reason: 'INTERNAL_ERROR' },
      { id: 'item-b', reason: 'INTERNAL_ERROR' }
    ])
    expect(mockedAdjustStorageUsed).toHaveBeenCalledWith(db, 'user-1', -totalBytes)
  })

  it('should process duplicate (type, id) pushes in waves that see each other, like the serial loop', async () => {
    // #given — the second lookup observes the row the first wave wrote
    const itemId = '550e8400-e29b-41d4-a716-446655440000'
    let lookupCalls = 0
    const { db, batches } = createPushDb({
      existing: () =>
        lookupCalls++ === 0
          ? []
          : [
              {
                item_type: 'note',
                item_id: itemId,
                version: 1,
                clock: '{"device-1":1}',
                size_bytes: 10,
                created_at: 111
              }
            ]
    })

    // #when
    const result = await processRecordPushBatch(
      db as unknown as D1Database,
      {} as R2Bucket,
      'user-1',
      'device-1',
      [
        createValidPushItem({ clock: { 'device-1': 1 } }),
        createValidPushItem({ clock: { 'device-1': 2 } })
      ]
    )

    // #then — both land, the second as version 2 with the later cursor
    expect(result.accepted).toEqual([itemId, itemId])
    expect(result.outcomes.map((outcome) => outcome.serverCursor)).toEqual([42, 43])
    const upserts = upsertStatements(batches)
    expect(upserts).toHaveLength(2)
    expect(upserts.map((stmt) => stmt.binds[8])).toEqual([1, 2])
    // The second wave preserves the created_at the first wave's row carries.
    expect(upserts[1].binds[16]).toBe(111)
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
    expect(stmt.bind).toHaveBeenCalledWith('device-1', 'user-1', 'default', 42, expect.any(Number))
    expect(stmt.run).toHaveBeenCalled()
  })
})

// ============================================================================
// Tests: processPushItem — storage quota enforcement
// ============================================================================

describe('processPushItem', () => {
  const mockedGetDevice = vi.mocked(getDevice)

  beforeEach(() => {
    vi.clearAllMocks()
    armCursorSequence(42)
    mockedReserveStorage.mockResolvedValue(undefined)
    mockedAdjustStorageUsed.mockResolvedValue(undefined)
    mockedVerifyEd25519.mockResolvedValue(true)
    vi.mocked(putBlob).mockResolvedValue({ etag: 'etag-1' } as unknown as R2Object)
    mockedGetDevice.mockResolvedValue({
      id: 'device-1',
      user_id: 'user-1',
      name: 'test',
      platform: 'desktop',
      os_version: null,
      app_version: '1.0.0',
      auth_public_key: btoa(String.fromCharCode(...new Array(32).fill(0))),
      push_token: null,
      revoked_at: null,
      last_sync_at: null,
      created_at: 1000,
      updated_at: 1000
    })
  })

  it('should reject push when storage quota would be exceeded', async () => {
    mockedReserveStorage.mockRejectedValue(
      new AppError(ErrorCodes.STORAGE_QUOTA_EXCEEDED, 'Storage quota exceeded', 413)
    )

    const { db } = createPushDb()

    // #when
    const result = await processPushItem(
      db as unknown as D1Database,
      {} as R2Bucket,
      'user-1',
      'device-1',
      createValidPushItem()
    )

    // #then
    expect(result.accepted).toBe(false)
    expect(result.reason).toBe('STORAGE_QUOTA_EXCEEDED')
  })

  it('should skip quota check when replacing item with smaller payload', async () => {
    // #given — existing item is 50000 bytes, new is smaller → sizeDelta ≤ 0
    const { db } = createPushDb({
      existing: [
        {
          item_type: 'note',
          item_id: '550e8400-e29b-41d4-a716-446655440000',
          version: 1,
          clock: '{"device-1":1}',
          created_at: 1000,
          size_bytes: 50000
        }
      ]
    })

    // #when
    const result = await processPushItem(
      db as unknown as D1Database,
      {} as R2Bucket,
      'user-1',
      'device-1',
      createValidPushItem({ clock: { 'device-1': 2 } })
    )

    // #then — accepted without reserving extra storage
    expect(result.accepted).toBe(true)
    expect(mockedReserveStorage).not.toHaveBeenCalled()
  })

  it('should preserve existing created_at when upserting an existing row', async () => {
    const { db, batches } = createPushDb({
      existing: [
        {
          item_type: 'note',
          item_id: '550e8400-e29b-41d4-a716-446655440000',
          version: 3,
          clock: '{"device-1":3}',
          created_at: 123456,
          size_bytes: 50000
        }
      ]
    })

    const result = await processPushItem(
      db as unknown as D1Database,
      {} as R2Bucket,
      'user-1',
      'device-1',
      createValidPushItem({ clock: { 'device-1': 4 } })
    )

    expect(result.accepted).toBe(true)
    const [upsert] = upsertStatements(batches)
    expect(upsert.binds[16]).toBe(123456)
    expect(upsert.binds[8]).toBe(4)
  })

  it('should write the payload to a type-scoped blob key so same-id items of different types never clobber each other', async () => {
    // Regression for the cross-type R2 collision: a project and a tag_definition
    // both named 'inbox' used to share ONE untyped blob key, so the later push
    // silently destroyed the other type's ciphertext and its signature could
    // never verify again.
    const runPush = async (type: PushItemInput['type']) => {
      const { db, batches } = createPushDb()
      const result = await processPushItem(
        db as unknown as D1Database,
        {} as R2Bucket,
        'user-1',
        'device-1',
        createValidPushItem({ id: 'inbox', type, clock: { 'device-1': 1 } }),
        'vault-1'
      )
      expect(result.accepted).toBe(true)
      const putKey = vi.mocked(putBlob).mock.lastCall?.[1] as string
      const [upsert] = upsertStatements(batches)
      const boundBlobKey = upsert.binds[5] as string
      expect(boundBlobKey).toBe(putKey)
      return putKey
    }

    const projectKey = await runPush('project')
    const tagKey = await runPush('tag_definition')

    // Keys are content-addressed since items-v3, so assert the type-scoped
    // prefix and cross-type disjointness rather than a literal full key.
    expect(projectKey).toMatch(/^user-1\/vaults\/vault-1\/items-v3\/project\/inbox\/[0-9a-f]{64}$/)
    expect(tagKey).toMatch(
      /^user-1\/vaults\/vault-1\/items-v3\/tag_definition\/inbox\/[0-9a-f]{64}$/
    )
    expect(projectKey).not.toBe(tagKey)
  })

  it('should batch sync item upsert and storage usage update atomically', async () => {
    const existingRow = {
      item_type: 'note',
      item_id: '550e8400-e29b-41d4-a716-446655440000',
      version: 3,
      clock: '{"device-1":3}',
      created_at: 123456,
      size_bytes: 50000
    }
    const { db, batches } = createPushDb({ existing: [existingRow] })

    const item = createValidPushItem({ clock: { 'device-1': 4 } })
    const result = await processPushItem(
      db as unknown as D1Database,
      {} as R2Bucket,
      'user-1',
      'device-1',
      item
    )

    expect(result.accepted).toBe(true)
    // db.batch call 1 = existing lookup, call 2 = the transactional write.
    expect(db.batch).toHaveBeenCalledTimes(2)
    const writeBatch = batches[1]
    expect(writeBatch).toHaveLength(2)
    expect(writeBatch[0].sql).toContain('INSERT INTO sync_items')
    expect(writeBatch[1].sql).toContain('MAX(0, storage_used + ?)')
    expect(writeBatch[1].binds).toEqual([payloadBytesOf(item) - 50000, 'user-1'])
  })

  it('should accept settings updates without top-level clock even if legacy rows have a stored clock', async () => {
    const { db } = createPushDb({
      existing: [
        {
          item_type: 'settings',
          item_id: '550e8400-e29b-41d4-a716-446655440000',
          version: 1,
          clock: '{"device-old":2}',
          created_at: 1000,
          size_bytes: 10
        }
      ]
    })

    const result = await processPushItem(
      db as unknown as D1Database,
      {} as R2Bucket,
      'user-1',
      'device-1',
      createValidPushItem({ type: 'settings', clock: undefined })
    )

    expect(result.accepted).toBe(true)
    expect(result.reason).toBeUndefined()
  })

  it('should reject unsupported types, missing required clocks, and legacy state vectors', async () => {
    const db = createMockDb()

    await expect(
      processPushItem(
        db as unknown as D1Database,
        {} as R2Bucket,
        'user-1',
        'device-1',
        createValidPushItem({ type: 'legacy' as PushItemInput['type'] })
      )
    ).resolves.toEqual({ accepted: false, reason: ErrorCodes.VALIDATION_ERROR })

    await expect(
      processPushItem(
        db as unknown as D1Database,
        {} as R2Bucket,
        'user-1',
        'device-1',
        createValidPushItem({ clock: undefined })
      )
    ).resolves.toEqual({ accepted: false, reason: ErrorCodes.VALIDATION_ERROR })

    await expect(
      processPushItem(
        db as unknown as D1Database,
        {} as R2Bucket,
        'user-1',
        'device-1',
        createValidPushItem({ stateVector: 'legacy-state' })
      )
    ).resolves.toEqual({ accepted: false, reason: ErrorCodes.VALIDATION_ERROR })
  })

  it('should reject when reserving storage fails for a growing payload', async () => {
    mockedReserveStorage.mockRejectedValue(
      new AppError(ErrorCodes.AUTH_INVALID_TOKEN, 'Invalid token', 401)
    )
    const selectStmt = createMockStatement()
    selectStmt.first.mockResolvedValue(null)
    const db = createMockDb()
    db.prepare.mockReturnValue(selectStmt)

    const result = await processPushItem(
      db as unknown as D1Database,
      {} as R2Bucket,
      'user-1',
      'device-1',
      createValidPushItem()
    )

    expect(result).toEqual({ accepted: false, reason: ErrorCodes.AUTH_INVALID_TOKEN })
  })

  it('should accept existing object clocks and existing rows without size metadata', async () => {
    const { db, batches } = createPushDb({
      existing: [
        {
          item_type: 'note',
          item_id: '550e8400-e29b-41d4-a716-446655440000',
          version: 1,
          clock: { 'device-1': 1 },
          createdAt: 987
        }
      ]
    })

    const result = await processPushItem(
      db as unknown as D1Database,
      {} as R2Bucket,
      'user-1',
      'device-1',
      createValidPushItem({ clock: { 'device-1': 2 } })
    )

    expect(result.accepted).toBe(true)
    const [upsert] = upsertStatements(batches)
    expect(upsert.binds[16]).toBe(987)
    expect(upsert.binds[8]).toBe(2)
  })

  it('should write tombstones for delete operations', async () => {
    const { db, batches } = createPushDb()

    const result = await processPushItem(
      db as unknown as D1Database,
      {} as R2Bucket,
      'user-1',
      'device-1',
      createValidPushItem({ operation: 'delete', deletedAt: undefined })
    )

    expect(result.accepted).toBe(true)
    const [upsert] = upsertStatements(batches)
    expect(upsert.binds[18]).toEqual(expect.any(Number))
  })

  it('should return AppError and unknown error codes from failed processing', async () => {
    const appErrorResult = await processPushItem(
      createMockDb() as unknown as D1Database,
      {} as R2Bucket,
      'user-1',
      'device-1',
      createValidPushItem({ dataNonce: btoa(String.fromCharCode(...new Array(23).fill(0))) })
    )
    expect(appErrorResult).toEqual({ accepted: false, reason: ErrorCodes.CRYPTO_INVALID_PAYLOAD })

    mockedSafeBase64Decode.mockImplementationOnce(() => {
      throw new Error('decoder exploded')
    })
    const unknownResult = await processPushItem(
      createMockDb() as unknown as D1Database,
      {} as R2Bucket,
      'user-1',
      'device-1',
      createValidPushItem()
    )
    expect(unknownResult).toEqual({ accepted: false, reason: 'INTERNAL_ERROR' })
  })
})

// ============================================================================
// Tests: sync-type negotiation
// ============================================================================

describe('sync-type negotiation', () => {
  it('getChanges binds only the negotiated types', async () => {
    // #given
    const db = createMockDb()
    const stmt = createMockStatement()
    db.prepare.mockReturnValue(stmt)

    // #when
    await getChanges(db as unknown as D1Database, 'user-1', 0, 10, 'vault-1', ['note', 'task'])

    // #then
    expect(db.prepare.mock.calls[0][0]).toContain('item_type IN (?, ?)')
    expect(stmt.bind).toHaveBeenCalledWith('user-1', 'vault-1', 0, 'note', 'task', 11)
  })

  it('getChanges defaults to the frozen legacy list when types are omitted', async () => {
    // #given
    const db = createMockDb()
    const stmt = createMockStatement()
    db.prepare.mockReturnValue(stmt)

    // #when
    await getChanges(db as unknown as D1Database, 'user-1', 0, 10, 'vault-1')

    // #then
    expect(stmt.bind).toHaveBeenCalledWith(
      'user-1',
      'vault-1',
      0,
      ...LEGACY_RECORD_SYNC_ITEM_TYPES,
      11
    )
  })

  it('getManifest binds only the negotiated types', async () => {
    // #given
    const db = createMockDb()
    const stmt = createMockStatement()
    db.prepare.mockReturnValue(stmt)

    // #when
    await getManifest(db as unknown as D1Database, 'user-1', 'vault-1', ['note'])

    // #then
    expect(db.prepare.mock.calls[0][0]).toContain('item_type IN (?)')
    expect(stmt.bind).toHaveBeenCalledWith('user-1', 'vault-1', 'note')
  })

  it('pullItems binds only the negotiated types', async () => {
    // #given
    const db = createMockDb()
    const stmt = createMockStatement()
    db.prepare.mockReturnValue(stmt)

    // #when
    await pullItems(
      db as unknown as D1Database,
      {} as unknown as R2Bucket,
      'user-1',
      ['item-1'],
      'vault-1',
      ['note', 'task']
    )

    // #then
    expect(db.prepare.mock.calls[0][0]).toContain('item_type IN (?, ?)')
    expect(stmt.bind).toHaveBeenCalledWith('user-1', 'vault-1', 'note', 'task', 'item-1')
  })

  // Finding 1 makes an empty negotiated list a valid, reachable state (a
  // header present but fully unrecognized). placeholdersFor([]) would emit
  // `item_type IN ()`, a SQL syntax error — these three functions must
  // short-circuit before ever touching the database.
  describe('empty negotiated types short-circuit', () => {
    it('getChanges returns an empty result without querying D1 and does not advance the cursor', async () => {
      // #given
      const db = createMockDb()

      // #when
      const result = await getChanges(db as unknown as D1Database, 'user-1', 42, 10, 'vault-1', [])

      // #then
      expect(result).toEqual({ items: [], deleted: [], hasMore: false, nextCursor: 42 })
      expect(db.prepare).not.toHaveBeenCalled()
    })

    it('getManifest returns an empty result without querying D1', async () => {
      // #given
      const db = createMockDb()

      // #when
      const result = await getManifest(db as unknown as D1Database, 'user-1', 'vault-1', [])

      // #then
      expect(result.items).toEqual([])
      expect(result.serverTime).toBeGreaterThan(0)
      expect(db.prepare).not.toHaveBeenCalled()
    })

    it('pullItems returns an empty array without querying D1', async () => {
      // #given
      const db = createMockDb()

      // #when
      const result = await pullItems(
        db as unknown as D1Database,
        {} as R2Bucket,
        'user-1',
        ['item-1'],
        'vault-1',
        []
      )

      // #then
      expect(result).toEqual([])
      expect(db.prepare).not.toHaveBeenCalled()
    })
  })
})

// ============================================================================
// Tests: torn-write protection (concurrent same-item pushes)
// ============================================================================

describe('concurrent same-item pushes (torn blob regression)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    armCursorSequence(42)
    mockedReserveStorage.mockResolvedValue(undefined)
    mockedVerifyEd25519.mockResolvedValue(true)
    mockedGetDevice.mockResolvedValue({
      id: 'device-1',
      user_id: 'user-1',
      name: 'test',
      platform: 'desktop',
      os_version: null,
      app_version: '1.0.0',
      auth_public_key: btoa(String.fromCharCode(...new Array(32).fill(0))),
      push_token: null,
      revoked_at: null,
      last_sync_at: null,
      created_at: 1000,
      updated_at: 1000
    })
  })

  it('keeps the winning row pointing at the exact bytes its signature covers', async () => {
    // Jerry's 2026-08-10 incident shape: two devices race to push the same
    // item id (external calendar events have deterministic ids, so every
    // device pushes the same ids independently). With a shared mutable blob
    // key, the interleaving putBlob(A), putBlob(B), upsert(B), upsert(A)
    // leaves A's signature on the row while B's bytes sit in the object —
    // the item then fails Ed25519 verification on every pull, forever.
    const r2 = new Map<string, string>()
    vi.mocked(putBlob).mockImplementation(async (_storage, key, data) => {
      r2.set(key, new TextDecoder().decode(new Uint8Array(data as ArrayBuffer)))
      return { etag: 'e' } as unknown as R2Object
    })

    const finalRow: { blobKey?: string; signature?: string } = {}
    const gates: Array<() => void> = []

    const makeGatedDb = () => {
      const prepare = vi.fn((sql: string) => {
        const stmt = {
          sql,
          binds: [] as unknown[],
          bind: (...args: unknown[]) => {
            stmt.binds = args
            return stmt
          },
          first: vi.fn().mockResolvedValue(null),
          run: vi.fn().mockResolvedValue({ success: true }),
          all: vi.fn().mockResolvedValue({ results: [] })
        }
        return stmt
      })
      const batch = vi.fn(async (statements: Array<{ sql: string; binds: unknown[] }>) => {
        // The existing-row lookup runs ungated; only the row WRITE stalls, so
        // the interleaving below is putBlob(A), putBlob(B), upsert(B), upsert(A).
        if (statements[0]?.sql.trimStart().startsWith('SELECT')) {
          return statements.map(() => ({ success: true, results: [] }))
        }
        await new Promise<void>((resolve) => gates.push(resolve))
        // 21 binds = the sync_items upsert (19 columns, plus the two
        // attribution columns). Identifying it by arity keeps this double from
        // matching the storage-adjustment statement in the same batch.
        const upsert = statements.find((stmt) => stmt.binds.length === 21)
        finalRow.blobKey = upsert?.binds[5] as string
        finalRow.signature = upsert?.binds[13] as string
        return statements.map(() => ({ success: true, results: [] }))
      })
      return { prepare, batch }
    }

    const sigA = btoa(String.fromCharCode(...new Array(64).fill(1)))
    const sigB = btoa(String.fromCharCode(...new Array(64).fill(2)))
    const itemA = createValidPushItem({
      encryptedData: btoa('payload-from-device-A'),
      signature: sigA
    })
    const itemB = createValidPushItem({
      encryptedData: btoa('payload-from-device-B'),
      signature: sigB,
      signerDeviceId: 'device-2',
      clock: { 'device-2': 1 }
    })

    const waitForGates = async (count: number) => {
      while (gates.length < count) await new Promise((resolve) => setTimeout(resolve, 0))
    }

    // Device A uploads its blob, then stalls just before its row write.
    const pushA = processPushItem(
      makeGatedDb() as unknown as D1Database,
      {} as R2Bucket,
      'user-1',
      'device-1',
      itemA
    )
    await waitForGates(1)

    // Device B pushes the same item id start-to-finish while A is stalled.
    const pushB = processPushItem(
      makeGatedDb() as unknown as D1Database,
      {} as R2Bucket,
      'user-1',
      'device-2',
      itemB
    )
    await waitForGates(2)
    gates[1]()
    await pushB

    // A's row write lands last, so A's signature owns the row.
    gates[0]()
    await pushA

    expect(finalRow.signature).toBe(sigA)
    // The row's blob must contain exactly the payload A signed.
    expect(r2.get(finalRow.blobKey ?? '')).toBe(serializePayload(itemA))
  })
})

// ============================================================================
// Tests: replaced-blob cleanup
// ============================================================================

describe('processPushItem replaced blob cleanup', () => {
  const oldBlobKey = 'user-1/vaults/default/items-v2/note/550e8400-e29b-41d4-a716-446655440000'

  const existingRow = {
    item_type: 'note',
    item_id: '550e8400-e29b-41d4-a716-446655440000',
    version: 1,
    clock: '{"device-1":1}',
    created_at: 1000,
    size_bytes: 10,
    blob_key: oldBlobKey
  }

  beforeEach(() => {
    vi.clearAllMocks()
    armCursorSequence(42)
    mockedReserveStorage.mockResolvedValue(undefined)
    mockedVerifyEd25519.mockResolvedValue(true)
    mockedGetDevice.mockResolvedValue({
      id: 'device-1',
      user_id: 'user-1',
      name: 'test',
      platform: 'desktop',
      os_version: null,
      app_version: '1.0.0',
      auth_public_key: btoa(String.fromCharCode(...new Array(32).fill(0))),
      push_token: null,
      revoked_at: null,
      last_sync_at: null,
      created_at: 1000,
      updated_at: 1000
    })
    vi.mocked(putBlob).mockResolvedValue({ etag: 'etag-1' } as unknown as R2Object)
  })

  it('deletes the replaced blob only after the row points at the new one', async () => {
    const { db } = createPushDb({ existing: [existingRow] })
    const storage = { delete: vi.fn().mockResolvedValue(undefined) } as unknown as R2Bucket

    const result = await processPushItem(
      db as unknown as D1Database,
      storage,
      'user-1',
      'device-1',
      createValidPushItem({ operation: 'update', clock: { 'device-1': 2 } })
    )

    expect(result.accepted).toBe(true)
    const deleteMock = vi.mocked(storage.delete)
    // Replaced blobs go out as ONE bulk delete call.
    expect(deleteMock).toHaveBeenCalledWith([oldBlobKey])
    // Ordering: the D1 rows must point at the new blobs (db.batch call 2, after
    // the lookup batch) before the old objects go.
    expect(db.batch.mock.invocationCallOrder[1]).toBeLessThan(
      deleteMock.mock.invocationCallOrder[0]
    )
  })

  it('does not delete anything for a first-time item', async () => {
    const { db } = createPushDb()
    const storage = { delete: vi.fn().mockResolvedValue(undefined) } as unknown as R2Bucket

    const result = await processPushItem(
      db as unknown as D1Database,
      storage,
      'user-1',
      'device-1',
      createValidPushItem()
    )

    expect(result.accepted).toBe(true)
    expect(vi.mocked(storage.delete)).not.toHaveBeenCalled()
  })

  it('still accepts the push when the old blob delete fails', async () => {
    const { db } = createPushDb({ existing: [existingRow] })
    const storage = {
      delete: vi.fn().mockRejectedValue(new Error('R2 hiccup'))
    } as unknown as R2Bucket

    const result = await processPushItem(
      db as unknown as D1Database,
      storage,
      'user-1',
      'device-1',
      createValidPushItem({ operation: 'update', clock: { 'device-1': 2 } })
    )

    expect(result.accepted).toBe(true)
  })
})

// ============================================================================
// Tests: pull tolerance for missing blobs
// ============================================================================

describe('pullItems missing blob tolerance', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('skips a row whose blob is missing instead of failing the whole page', async () => {
    // A dangling row (blob deleted, row alive) must not wedge every puller:
    // one 404 used to reject the whole Promise.all, so the pull page failed
    // on every retry and the client cursor never advanced.
    const stmt = createMockStatement()
    stmt.all.mockResolvedValue({
      results: [
        {
          item_id: 'item-gone',
          item_type: 'note',
          blob_key: 'user-1/vaults/default/items-v2/note/item-gone',
          crypto_version: 1,
          operation: 'update',
          signer_device_id: 'device-1',
          signature: 'sig-gone',
          state_vector: null,
          clock: null,
          deleted_at: null,
          server_cursor: 7
        },
        {
          item_id: 'item-ok',
          item_type: 'note',
          blob_key: 'user-1/vaults/default/items-v2/note/item-ok',
          crypto_version: 1,
          operation: 'update',
          signer_device_id: 'device-1',
          signature: 'sig-ok',
          state_vector: null,
          clock: null,
          deleted_at: null,
          server_cursor: 8
        }
      ]
    })
    const db = createMockDb()
    db.prepare.mockReturnValue(stmt)
    vi.mocked(getBlob).mockImplementation(async (_storage, key) =>
      key.includes('item-gone')
        ? null
        : ({
            body: JSON.stringify({
              encryptedKey: 'ek',
              keyNonce: 'kn',
              encryptedData: 'ed',
              dataNonce: 'dn'
            })
          } as unknown as R2ObjectBody)
    )

    const result = await pullItems(db as unknown as D1Database, {} as R2Bucket, 'user-1', [
      'item-gone',
      'item-ok'
    ])

    expect(result.map((item) => item.id)).toEqual(['item-ok'])
  })
})
