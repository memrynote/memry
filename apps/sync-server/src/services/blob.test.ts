import { describe, it, expect, vi, beforeEach } from 'vitest'

import { AppError, ErrorCodes } from '../lib/errors'

import {
  generateBlobKey,
  generateItemBlobKey,
  generateCrdtKey,
  generateAttachmentManifestKey,
  generateAttachmentChunkKey,
  putBlob,
  getBlob,
  deleteBlob,
  deleteByPrefix
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
  it('should create vault-scoped item key', () => {
    expect(generateBlobKey('user-1', 'item-1', 'vault-1')).toBe(
      'user-1/vaults/vault-1/items/item-1'
    )
  })
})

describe('generateItemBlobKey', () => {
  it('should create a content-addressed, type-scoped item key', () => {
    expect(generateItemBlobKey('user-1', 'task', 'item-1', 'vault-1', 'hash-abc')).toBe(
      'user-1/vaults/vault-1/items-v3/task/item-1/hash-abc'
    )
  })

  it('should give distinct keys to same-id items of different types', () => {
    const projectKey = generateItemBlobKey('user-1', 'project', 'inbox', 'vault-1', 'hash-abc')
    const tagKey = generateItemBlobKey('user-1', 'tag_definition', 'inbox', 'vault-1', 'hash-abc')
    expect(projectKey).not.toBe(tagKey)
  })

  it('should give distinct keys to different payloads of the same item', () => {
    // Two concurrent pushes of the same item must never overwrite each other's
    // object — the D1 row's signature has to keep pointing at the exact bytes
    // it was computed over.
    const first = generateItemBlobKey('user-1', 'task', 'item-1', 'vault-1', 'hash-a')
    const second = generateItemBlobKey('user-1', 'task', 'item-1', 'vault-1', 'hash-b')
    expect(first).not.toBe(second)
  })

  it('should never collide with the legacy untyped namespace, even for slash-containing ids', () => {
    // folder_config ids are folder paths and may contain slashes; a legacy key
    // like items/task/x must not equal a typed key for task 'x'.
    const legacyNestedFolder = generateBlobKey('user-1', 'task/x/hash-a', 'vault-1')
    const typedTask = generateItemBlobKey('user-1', 'task', 'x', 'vault-1', 'hash-a')
    expect(legacyNestedFolder).not.toBe(typedTask)
  })
})

describe('generateCrdtKey', () => {
  it('should create vault-scoped CRDT snapshot key', () => {
    expect(generateCrdtKey('user-1', 'note-1', 'vault-1')).toBe(
      'user-1/vaults/vault-1/crdt/note-1/snapshot'
    )
  })
})

describe('generateAttachmentManifestKey', () => {
  it('should create vault-scoped manifest key', () => {
    expect(generateAttachmentManifestKey('user-1', 'att-1', 'vault-1')).toBe(
      'user-1/vaults/vault-1/attachments/att-1/manifest'
    )
  })
})

describe('generateAttachmentChunkKey', () => {
  it('should create vault-scoped chunk key with hash', () => {
    expect(generateAttachmentChunkKey('user-1', 'vault-1', 'hash-1')).toBe(
      'user-1/vaults/vault-1/chunks/hash-1'
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

  it('should throw STORAGE_UPLOAD_FAILED when R2 put returns null', async () => {
    // #given
    storage.put.mockResolvedValue(null)

    // #when / #then
    await expect(
      putBlob(storage as unknown as R2Bucket, 'user-1/items/x', new ArrayBuffer(0), 'user-1')
    ).rejects.toThrow(AppError)

    try {
      storage.put.mockResolvedValue(null)
      await putBlob(storage as unknown as R2Bucket, 'user-1/items/x', new ArrayBuffer(0), 'user-1')
    } catch (e) {
      expect((e as AppError).code).toBe(ErrorCodes.STORAGE_UPLOAD_FAILED)
    }
  })

  it('should throw STORAGE_QUOTA_EXCEEDED for quota-related R2 errors', async () => {
    // #given
    storage.put.mockRejectedValue(new Error('Storage quota exceeded for bucket'))

    // #when / #then
    await expect(
      putBlob(storage as unknown as R2Bucket, 'user-1/items/x', new ArrayBuffer(0), 'user-1')
    ).rejects.toThrow(AppError)

    try {
      storage.put.mockRejectedValue(new Error('Storage quota exceeded for bucket'))
      await putBlob(storage as unknown as R2Bucket, 'user-1/items/x', new ArrayBuffer(0), 'user-1')
    } catch (e) {
      expect((e as AppError).code).toBe(ErrorCodes.STORAGE_QUOTA_EXCEEDED)
      expect((e as AppError).statusCode).toBe(413)
    }
  })

  it('should throw STORAGE_UNAUTHORIZED for permission-related R2 errors', async () => {
    // #given
    storage.put.mockRejectedValue(new Error('Access denied: forbidden'))

    // #when / #then
    await expect(
      putBlob(storage as unknown as R2Bucket, 'user-1/items/x', new ArrayBuffer(0), 'user-1')
    ).rejects.toThrow(AppError)

    try {
      storage.put.mockRejectedValue(new Error('Access denied: forbidden'))
      await putBlob(storage as unknown as R2Bucket, 'user-1/items/x', new ArrayBuffer(0), 'user-1')
    } catch (e) {
      expect((e as AppError).code).toBe(ErrorCodes.STORAGE_UNAUTHORIZED)
      expect((e as AppError).statusCode).toBe(403)
    }
  })

  it('should throw STORAGE_UPLOAD_FAILED for unknown R2 errors', async () => {
    // #given
    storage.put.mockRejectedValue(new Error('Network timeout'))

    // #when / #then
    await expect(
      putBlob(storage as unknown as R2Bucket, 'user-1/items/x', new ArrayBuffer(0), 'user-1')
    ).rejects.toThrow(AppError)

    try {
      storage.put.mockRejectedValue(new Error('Network timeout'))
      await putBlob(storage as unknown as R2Bucket, 'user-1/items/x', new ArrayBuffer(0), 'user-1')
    } catch (e) {
      expect((e as AppError).code).toBe(ErrorCodes.STORAGE_UPLOAD_FAILED)
      expect((e as AppError).statusCode).toBe(500)
    }
  })
})

// ============================================================================
// Tests: putBlob transient-failure retry
//
// Production evidence: a ~5 minute burst of R2 put failures ("put: Please look
// at https://www.cloudflarestatus.com for issues") surfaced as 500s. The key is
// deterministic, so a put retry is idempotent.
// ============================================================================

const R2_TRANSIENT_MESSAGE = 'put: Please look at https://www.cloudflarestatus.com for issues'

describe('putBlob retry on transient R2 failures', () => {
  let storage: ReturnType<typeof createMockStorage>

  beforeEach(() => {
    storage = createMockStorage()
  })

  it('should retry a transient R2 put failure and succeed without surfacing an error', async () => {
    // #given a put that fails once, then succeeds (the Cloudflare-incident shape)
    storage.put
      .mockRejectedValueOnce(new Error(R2_TRANSIENT_MESSAGE))
      .mockResolvedValueOnce(createMockR2Object())

    // #when
    const result = await putBlob(
      storage as unknown as R2Bucket,
      'user-1/items/x',
      new ArrayBuffer(10),
      'user-1'
    )

    // #then the caller never sees the transient failure
    expect(result).toBeDefined()
    expect(storage.put).toHaveBeenCalledTimes(2)
  })

  it('should retry twice before giving up and surface a typed STORAGE_UPLOAD_FAILED', async () => {
    // #given R2 is persistently failing
    storage.put.mockRejectedValue(new Error(R2_TRANSIENT_MESSAGE))

    // #when / #then
    await expect(
      putBlob(storage as unknown as R2Bucket, 'user-1/items/x', new ArrayBuffer(10), 'user-1')
    ).rejects.toMatchObject({
      name: 'AppError',
      code: ErrorCodes.STORAGE_UPLOAD_FAILED,
      statusCode: 500
    })
    expect(storage.put).toHaveBeenCalledTimes(3)
  })

  it('should not retry quota failures', async () => {
    // #given a terminal, non-transient failure
    storage.put.mockRejectedValue(new Error('Storage quota exceeded for bucket'))

    // #when / #then retrying a quota rejection only burns Worker budget
    await expect(
      putBlob(storage as unknown as R2Bucket, 'user-1/items/x', new ArrayBuffer(10), 'user-1')
    ).rejects.toMatchObject({ code: ErrorCodes.STORAGE_QUOTA_EXCEEDED })
    expect(storage.put).toHaveBeenCalledTimes(1)
  })

  it('should not retry permission failures', async () => {
    // #given
    storage.put.mockRejectedValue(new Error('Access denied: forbidden'))

    // #when / #then
    await expect(
      putBlob(storage as unknown as R2Bucket, 'user-1/items/x', new ArrayBuffer(10), 'user-1')
    ).rejects.toMatchObject({ code: ErrorCodes.STORAGE_UNAUTHORIZED })
    expect(storage.put).toHaveBeenCalledTimes(1)
  })

  it('should not retry a stream body, which cannot be replayed after a failed attempt', async () => {
    // #given a body that is consumed by the first attempt
    storage.put.mockRejectedValue(new Error(R2_TRANSIENT_MESSAGE))

    // #when / #then re-putting a consumed stream would upload a partial object
    await expect(
      putBlob(storage as unknown as R2Bucket, 'user-1/items/x', new ReadableStream(), 'user-1')
    ).rejects.toMatchObject({ code: ErrorCodes.STORAGE_UPLOAD_FAILED })
    expect(storage.put).toHaveBeenCalledTimes(1)
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

// ============================================================================
// Tests: deleteByPrefix
// ============================================================================

const makeBucket = (pages: Array<{ keys: string[]; truncated: boolean; cursor?: string }>) => {
  const deleted: string[][] = []
  let call = 0
  return {
    deleted,
    bucket: {
      list: vi.fn(async () => {
        const page = pages[call++]
        return {
          objects: page.keys.map((key) => ({ key })),
          truncated: page.truncated,
          cursor: page.cursor
        }
      }),
      delete: vi.fn(async (keys: string[]) => {
        deleted.push(keys)
      })
    } as unknown as R2Bucket
  }
}

describe('deleteByPrefix', () => {
  it('deletes every page of a truncated listing', async () => {
    const { bucket, deleted } = makeBucket([
      { keys: ['u1/vaults/v1/items/a'], truncated: true, cursor: 'c1' },
      { keys: ['u1/vaults/v1/items/b'], truncated: false }
    ])

    const count = await deleteByPrefix(bucket, 'u1/vaults/v1/', 'u1')

    expect(count).toBe(2)
    expect(deleted).toEqual([['u1/vaults/v1/items/a'], ['u1/vaults/v1/items/b']])
    expect(bucket.list).toHaveBeenCalledTimes(2)
  })

  it('skips the delete call for an empty page', async () => {
    const { bucket, deleted } = makeBucket([{ keys: [], truncated: false }])

    const count = await deleteByPrefix(bucket, 'u1/vaults/v1/', 'u1')

    expect(count).toBe(0)
    expect(deleted).toEqual([])
    expect(bucket.delete).not.toHaveBeenCalled()
  })

  it('refuses a prefix belonging to another user', async () => {
    const { bucket } = makeBucket([{ keys: [], truncated: false }])

    await expect(deleteByPrefix(bucket, 'u2/vaults/v1/', 'u1')).rejects.toThrow(AppError)
    expect(bucket.list).not.toHaveBeenCalled()
  })
})
