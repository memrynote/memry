import { describe, it, expect, vi, beforeEach } from 'vitest'

import { AppError, ErrorCodes } from '../lib/errors'

import {
  generateBlobKey,
  generateCrdtKey,
  generateAttachmentChunkKey,
  putBlob,
  getBlob,
  deleteBlob
} from './blob'

// ============================================================================
// R2 mock helpers
// ============================================================================

const createMockR2Object = (etag = 'etag-1') => ({
  etag,
  checksums: {
    toJSON: vi.fn().mockReturnValue({ md5: 'abc123' })
  }
})

const createMockR2ObjectBody = (etag = 'etag-1') => ({
  ...createMockR2Object(etag),
  body: new ReadableStream(),
  arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(0))
})

const createMockStorage = () => ({
  put: vi.fn().mockResolvedValue(createMockR2Object()),
  get: vi.fn().mockResolvedValue(createMockR2ObjectBody()),
  head: vi.fn().mockResolvedValue(null),
  delete: vi.fn().mockResolvedValue(undefined)
})

// ============================================================================
// Tests: key generation helpers
// ============================================================================

describe('generateBlobKey', () => {
  it('should create user-scoped item key', () => {
    expect(generateBlobKey('user-1', 'item-1')).toBe('user-1/items/item-1')
  })
})

describe('generateCrdtKey', () => {
  it('should create user-scoped CRDT snapshot key', () => {
    expect(generateCrdtKey('user-1', 'note-1')).toBe('user-1/crdt/note-1/snapshot')
  })
})

describe('generateAttachmentChunkKey', () => {
  it('should create user-scoped chunk key with index', () => {
    expect(generateAttachmentChunkKey('user-1', 'att-1', 3)).toBe(
      'user-1/attachments/att-1/chunks/3'
    )
  })
})

// ============================================================================
// Tests: putBlob
// ============================================================================

describe('putBlob', () => {
  let storage: ReturnType<typeof createMockStorage>

  beforeEach(() => {
    storage = createMockStorage()
  })

  it('should store a blob when key belongs to user', async () => {
    // #given
    const data = new ArrayBuffer(10)

    // #when
    const result = await putBlob(storage as unknown as R2Bucket, 'user-1/items/x', data, 'user-1')

    // #then
    expect(storage.put).toHaveBeenCalledWith('user-1/items/x', data)
    expect(result).toBeDefined()
  })

  it('should throw STORAGE_UNAUTHORIZED when key does not belong to user', async () => {
    // #when / #then
    await expect(
      putBlob(storage as unknown as R2Bucket, 'other-user/items/x', new ArrayBuffer(0), 'user-1')
    ).rejects.toThrow(AppError)

    try {
      await putBlob(
        storage as unknown as R2Bucket,
        'other-user/items/x',
        new ArrayBuffer(0),
        'user-1'
      )
    } catch (e) {
      expect((e as AppError).code).toBe(ErrorCodes.STORAGE_UNAUTHORIZED)
      expect((e as AppError).statusCode).toBe(403)
    }
  })

  it('should check etag when expectedEtag is provided and no conflict exists', async () => {
    // #given
    storage.head.mockResolvedValue({ etag: 'etag-match' })

    // #when
    await putBlob(storage as unknown as R2Bucket, 'user-1/items/x', new ArrayBuffer(0), 'user-1', {
      expectedEtag: 'etag-match'
    })

    // #then
    expect(storage.head).toHaveBeenCalledWith('user-1/items/x')
    expect(storage.put).toHaveBeenCalled()
  })

  it('should throw STORAGE_VERSION_CONFLICT on etag mismatch', async () => {
    // #given
    storage.head.mockResolvedValue({ etag: 'etag-old' })

    // #when / #then
    await expect(
      putBlob(storage as unknown as R2Bucket, 'user-1/items/x', new ArrayBuffer(0), 'user-1', {
        expectedEtag: 'etag-new'
      })
    ).rejects.toThrow(AppError)

    try {
      await putBlob(
        storage as unknown as R2Bucket,
        'user-1/items/x',
        new ArrayBuffer(0),
        'user-1',
        { expectedEtag: 'etag-new' }
      )
    } catch (e) {
      expect((e as AppError).code).toBe(ErrorCodes.STORAGE_VERSION_CONFLICT)
    }
  })

  it('should delete blob and throw on content hash mismatch', async () => {
    // #given
    const r2Obj = createMockR2Object()
    r2Obj.checksums.toJSON.mockReturnValue({ md5: 'actual-hash' })
    storage.put.mockResolvedValue(r2Obj)

    // #when / #then
    await expect(
      putBlob(storage as unknown as R2Bucket, 'user-1/items/x', new ArrayBuffer(0), 'user-1', {
        contentHash: 'expected-hash'
      })
    ).rejects.toThrow(AppError)

    expect(storage.delete).toHaveBeenCalledWith('user-1/items/x')
  })
})

// ============================================================================
// Tests: getBlob
// ============================================================================

describe('getBlob', () => {
  let storage: ReturnType<typeof createMockStorage>

  beforeEach(() => {
    storage = createMockStorage()
  })

  it('should retrieve a blob when key belongs to user', async () => {
    // #when
    const result = await getBlob(storage as unknown as R2Bucket, 'user-1/items/x', 'user-1')

    // #then
    expect(storage.get).toHaveBeenCalledWith('user-1/items/x')
    expect(result).toBeDefined()
  })

  it('should return null when blob does not exist', async () => {
    // #given
    storage.get.mockResolvedValue(null)

    // #when
    const result = await getBlob(storage as unknown as R2Bucket, 'user-1/items/x', 'user-1')

    // #then
    expect(result).toBeNull()
  })

  it('should throw STORAGE_UNAUTHORIZED when key does not belong to user', async () => {
    await expect(
      getBlob(storage as unknown as R2Bucket, 'other-user/items/x', 'user-1')
    ).rejects.toThrow(AppError)
  })
})

// ============================================================================
// Tests: deleteBlob
// ============================================================================

describe('deleteBlob', () => {
  it('should delete a blob when key belongs to user', async () => {
    // #given
    const storage = createMockStorage()

    // #when
    await deleteBlob(storage as unknown as R2Bucket, 'user-1/items/x', 'user-1')

    // #then
    expect(storage.delete).toHaveBeenCalledWith('user-1/items/x')
  })

  it('should throw STORAGE_UNAUTHORIZED when key does not belong to user', async () => {
    // #given
    const storage = createMockStorage()

    // #when / #then
    await expect(
      deleteBlob(storage as unknown as R2Bucket, 'other-user/items/x', 'user-1')
    ).rejects.toThrow(AppError)
  })
})
