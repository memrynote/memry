import { AppError, ErrorCodes } from '../lib/errors'

export const generateBlobKey = (userId: string, itemId: string, vaultId = 'default'): string =>
  `${userId}/vaults/${vaultId}/items/${itemId}`

// Sync-item payload keys must include the item type: item ids are human-readable
// and collide across types by design (default project id 'inbox', tag_definition
// id = lowercased tag name, folder_config id = folder path), so an untyped key
// makes a project and a tag named 'inbox' overwrite ONE R2 object while D1 keeps
// two rows — the losing row's signature can never verify again and its payload
// is silently destroyed ('items-v2' fixed that; folder_config ids may contain
// slashes, so nesting types under 'items/' could still collide with an old key).
//
// Keys must ALSO include the content hash: a mutable per-item key let two
// concurrent pushes of the same item id tear the row apart — putBlob(A),
// putBlob(B), upsert(B), upsert(A) leaves A's signature on the D1 row with B's
// bytes in R2, and the item fails Ed25519 verification on every pull until
// someone re-pushes it. External calendar events made this real: their ids are
// deterministic, so every device pushes the same ids independently. With the
// hash in the key ('items-v3') each push writes its own immutable object and
// the row always points at exactly the bytes its signature covers; the loser
// of an upsert race leaks one bounded orphan object instead of poisoning the
// item. Reads are unaffected: every consumer reads the per-row stored
// blob_key, never re-derives it, so v2 and legacy untyped rows keep resolving
// to their old objects.
export const generateItemBlobKey = (
  userId: string,
  itemType: string,
  itemId: string,
  vaultId = 'default',
  contentHash: string
): string => `${userId}/vaults/${vaultId}/items-v3/${itemType}/${itemId}/${contentHash}`

export const generateCrdtKey = (userId: string, noteId: string, vaultId = 'default'): string =>
  `${userId}/vaults/${vaultId}/crdt/${noteId}/snapshot`

export const generateAttachmentManifestKey = (
  userId: string,
  attachmentId: string,
  vaultId = 'default'
): string => `${userId}/vaults/${vaultId}/attachments/${attachmentId}/manifest`

export const generateAttachmentChunkKey = (
  userId: string,
  vaultId: string,
  chunkHash: string
): string => `${userId}/vaults/${vaultId}/chunks/${chunkHash}`

const assertKeyBelongsToUser = (key: string, userId: string): void => {
  if (!key.startsWith(`${userId}/`)) {
    throw new AppError(ErrorCodes.STORAGE_UNAUTHORIZED, 'Blob access denied', 403)
  }
}

// Blob keys are deterministic, so a put retry overwrites the same object and is
// idempotent. Delays are kept short and bounded: the retries only wait on I/O
// (they burn wall time, not the Worker CPU budget), but a request still has to
// finish, so the worst case adds ~350ms rather than seconds.
const PUT_RETRY_DELAYS_MS = [100, 250]

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const classifyPutError = (err: unknown): AppError => {
  if (err instanceof AppError) return err
  const msg = err instanceof Error ? err.message : String(err)
  if (/quota|limit|exceeded/i.test(msg)) {
    return new AppError(ErrorCodes.STORAGE_QUOTA_EXCEEDED, `Storage quota exceeded: ${msg}`, 413)
  }
  if (/forbidden|permission|unauthorized|access denied/i.test(msg)) {
    return new AppError(ErrorCodes.STORAGE_UNAUTHORIZED, `Storage permission error: ${msg}`, 403)
  }
  return new AppError(ErrorCodes.STORAGE_UPLOAD_FAILED, `Blob upload failed: ${msg}`, 500)
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

  // A stream body is consumed by the first attempt, so it cannot be replayed
  // without risking a partial upload. Retry any buffered body; only an
  // unreplayable stream is excluded (a future non-ArrayBuffer buffered body
  // such as a Uint8Array must not silently lose its retry).
  const canRetry = !(data instanceof ReadableStream)

  for (let attempt = 0; ; attempt++) {
    try {
      const r2Result = await storage.put(key, data)
      if (!r2Result) {
        throw new AppError(ErrorCodes.STORAGE_UPLOAD_FAILED, 'R2 put returned null', 500)
      }
      return r2Result
    } catch (err) {
      const appError = classifyPutError(err)
      const delayMs = PUT_RETRY_DELAYS_MS[attempt]
      // Only transient failures are worth retrying; quota and permission
      // rejections are terminal and would just burn budget.
      const isTransient = appError.code === ErrorCodes.STORAGE_UPLOAD_FAILED
      if (!canRetry || !isTransient || delayMs === undefined) {
        throw appError
      }
      await sleep(delayMs)
    }
  }
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

/**
 * Delete many objects in ONE R2 call. R2 accepts up to 1000 keys per delete;
 * callers here pass at most one key per pushed item (batch ceiling 100), so no
 * chunking is needed.
 */
export const deleteBlobs = async (
  storage: R2Bucket,
  keys: string[],
  userId: string
): Promise<void> => {
  if (keys.length === 0) return
  for (const key of keys) {
    assertKeyBelongsToUser(key, userId)
  }
  await storage.delete(keys)
}

/**
 * Delete every object under a prefix, honoring R2 list pagination.
 * The prefix must be inside the caller's own namespace.
 */
export const deleteByPrefix = async (
  storage: R2Bucket,
  prefix: string,
  userId: string
): Promise<number> => {
  assertKeyBelongsToUser(prefix, userId)

  let cursor: string | undefined
  let deleted = 0
  do {
    const listing = await storage.list({ prefix, cursor })
    const keys = listing.objects.map((o) => o.key)
    if (keys.length > 0) {
      await storage.delete(keys)
      deleted += keys.length
    }
    cursor = listing.truncated ? listing.cursor : undefined
  } while (cursor)

  return deleted
}
