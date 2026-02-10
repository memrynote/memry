import { describe, expect, it, vi } from 'vitest'

import {
  deleteBlob,
  generateAttachmentChunkKey,
  generateBlobKey,
  generateCrdtKey,
  getBlob,
  putBlob
} from './blob'

describe('blob service helpers', () => {
  it('generates deterministic object keys', () => {
    expect(generateBlobKey('user-1', 'item-1')).toBe('user-1/items/item-1')
    expect(generateCrdtKey('user-1', 'note-1')).toBe('user-1/crdt/note-1/snapshot')
    expect(generateAttachmentChunkKey('user-1', 'att-1', 4)).toBe(
      'user-1/attachments/att-1/chunks/4'
    )
  })

  it('delegates blob operations to R2 bucket methods', async () => {
    const object = { etag: 'etag-1' }
    const put = vi.fn(async () => object)
    const get = vi.fn(async () => ({ body: 'data' }))
    const remove = vi.fn(async () => undefined)

    const storage = {
      put,
      get,
      delete: remove
    } as unknown as R2Bucket

    const data = new TextEncoder().encode('hello').buffer

    expect(await putBlob(storage, 'key', data)).toEqual(object)
    expect(await getBlob(storage, 'key')).toEqual({ body: 'data' })
    await deleteBlob(storage, 'key')

    expect(put).toHaveBeenCalledWith('key', data)
    expect(get).toHaveBeenCalledWith('key')
    expect(remove).toHaveBeenCalledWith('key')
  })
})
