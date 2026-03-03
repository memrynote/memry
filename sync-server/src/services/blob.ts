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
  options?: { expectedEtag?: string }
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

  let result: R2Object
  try {
    const r2Result = await storage.put(key, data)
    if (!r2Result) {
      throw new AppError(ErrorCodes.STORAGE_UPLOAD_FAILED, 'R2 put returned null', 500)
    }
    result = r2Result
  } catch (err) {
    if (err instanceof AppError) throw err
    const msg = err instanceof Error ? err.message : String(err)
    if (/quota|limit|exceeded/i.test(msg)) {
      throw new AppError(ErrorCodes.STORAGE_QUOTA_EXCEEDED, `Storage quota exceeded: ${msg}`, 413)
    }
    if (/forbidden|permission|unauthorized|access denied/i.test(msg)) {
      throw new AppError(ErrorCodes.STORAGE_UNAUTHORIZED, `Storage permission error: ${msg}`, 403)
    }
    throw new AppError(ErrorCodes.STORAGE_UPLOAD_FAILED, `Blob upload failed: ${msg}`, 500)
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

export const deleteBlob = async (storage: R2Bucket, key: string, userId: string): Promise<void> => {
  assertKeyBelongsToUser(key, userId)
  await storage.delete(key)
}
