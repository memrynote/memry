import { AppError, ErrorCodes } from '../lib/errors'

export const generateBlobKey = (userId: string, itemId: string): string =>
  `${userId}/items/${itemId}`

export const generateCrdtKey = (userId: string, noteId: string): string =>
  `${userId}/crdt/${noteId}/snapshot`

export const generateAttachmentChunkKey = (
  userId: string,
  attachmentId: string,
  index: number
): string => `${userId}/attachments/${attachmentId}/chunks/${index}`

const assertKeyBelongsToUser = (key: string, userId: string): void => {
  if (!key.startsWith(`${userId}/`)) {
    throw new AppError(ErrorCodes.STORAGE_UNAUTHORIZED, 'Blob access denied', 403)
  }
}

export const putBlob = async (
  storage: R2Bucket,
  key: string,
  data: ArrayBuffer | ReadableStream,
  userId: string,
  options?: { expectedEtag?: string; contentHash?: string }
): Promise<R2Object> => {
  assertKeyBelongsToUser(key, userId)

  if (options?.expectedEtag) {
    const existing = await storage.head(key)
    if (existing && existing.etag !== options.expectedEtag) {
      throw new AppError(
        ErrorCodes.STORAGE_VERSION_CONFLICT,
        'Blob version conflict: etag mismatch',
        409
      )
    }
  }

  const result = await storage.put(key, data)

  if (options?.contentHash && result.checksums.toJSON().md5) {
    const storedHash = result.checksums.toJSON().md5
    if (storedHash && storedHash !== options.contentHash) {
      await storage.delete(key)
      throw new AppError(
        ErrorCodes.STORAGE_HASH_MISMATCH,
        'Content hash mismatch after upload',
        422
      )
    }
  }

  return result
}

export const getBlob = async (
  storage: R2Bucket,
  key: string,
  userId: string
): Promise<R2ObjectBody | null> => {
  assertKeyBelongsToUser(key, userId)
  return storage.get(key)
}

export const deleteBlob = async (
  storage: R2Bucket,
  key: string,
  userId: string
): Promise<void> => {
  assertKeyBelongsToUser(key, userId)
  await storage.delete(key)
}
