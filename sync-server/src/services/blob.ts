export const generateBlobKey = (userId: string, itemId: string): string =>
  `${userId}/items/${itemId}`

export const generateCrdtKey = (userId: string, noteId: string): string =>
  `${userId}/crdt/${noteId}/snapshot`

export const generateAttachmentChunkKey = (
  userId: string,
  attachmentId: string,
  index: number
): string => `${userId}/attachments/${attachmentId}/chunks/${index}`

export const putBlob = async (
  storage: R2Bucket,
  key: string,
  data: ArrayBuffer | ReadableStream
): Promise<R2Object> => storage.put(key, data)

export const getBlob = async (
  storage: R2Bucket,
  key: string
): Promise<R2ObjectBody | null> => storage.get(key)

export const deleteBlob = async (
  storage: R2Bucket,
  key: string
): Promise<void> => {
  await storage.delete(key)
}
