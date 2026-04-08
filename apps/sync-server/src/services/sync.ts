import { CRYPTO_VERSION, ED25519_PARAMS, XCHACHA20_PARAMS } from '@memry/contracts/crypto'
import type {
  ChangesResponse,
  EncryptedItemPayload,
  PullItemResponse,
  PushItemInput,
  PushResponse,
  SyncItemRef,
  SyncManifest,
  SyncStatus,
  VectorClock
} from '@memry/contracts/sync-api'
import { encodeSignaturePayload } from '../lib/cbor'
import { safeBase64Decode, verifyEd25519 } from '../lib/encoding'
import { AppError, ErrorCodes } from '../lib/errors'
import { generateBlobKey, getBlob, putBlob } from './blob'
import { getNextCursor } from './cursor'
import { getDevice } from './device'
import { checkQuota } from './quota'
import { getUserById } from './user'

const MAX_ENCRYPTED_DATA_BYTES = 5 * 1024 * 1024
const DEFAULT_CHANGES_LIMIT = 100
const MAX_CHANGES_LIMIT = 500

interface ExistingSyncItemRow {
  version: number
  clock: string | VectorClock | null
  size_bytes?: number | null
  created_at?: number | null
  createdAt?: number | null
}

interface StoredSyncItemPullRow {
  item_id: string
  item_type: string
  blob_key: string
  crypto_version: number
  operation: string
  signer_device_id: string | null
  signature: string | null
  state_vector: string | null
  clock: string | null
  deleted_at: number | null
  server_cursor: number
}

export interface RecordPushBatchOutcome {
  id: string
  type: PushItemInput['type']
  accepted: boolean
  reason?: string
  serverCursor?: number
}

export interface RecordPushBatchResult extends PushResponse {
  outcomes: RecordPushBatchOutcome[]
}

export const validateEncryptedFields = (item: PushItemInput): void => {
  const dataNonce = safeBase64Decode(item.dataNonce)
  if (dataNonce.length !== XCHACHA20_PARAMS.NONCE_LENGTH) {
    throw new AppError(
      ErrorCodes.CRYPTO_INVALID_PAYLOAD,
      `dataNonce must be ${XCHACHA20_PARAMS.NONCE_LENGTH} bytes, got ${dataNonce.length}`,
      400
    )
  }

  const keyNonce = safeBase64Decode(item.keyNonce)
  if (keyNonce.length !== XCHACHA20_PARAMS.NONCE_LENGTH) {
    throw new AppError(
      ErrorCodes.CRYPTO_INVALID_PAYLOAD,
      `keyNonce must be ${XCHACHA20_PARAMS.NONCE_LENGTH} bytes, got ${keyNonce.length}`,
      400
    )
  }

  const encryptedKey = safeBase64Decode(item.encryptedKey)
  const minKeyLength = XCHACHA20_PARAMS.KEY_LENGTH + XCHACHA20_PARAMS.TAG_LENGTH
  if (encryptedKey.length < minKeyLength) {
    throw new AppError(
      ErrorCodes.CRYPTO_INVALID_PAYLOAD,
      `encryptedKey must be >= ${minKeyLength} bytes, got ${encryptedKey.length}`,
      400
    )
  }

  const encryptedData = safeBase64Decode(item.encryptedData)
  if (encryptedData.length > MAX_ENCRYPTED_DATA_BYTES) {
    throw new AppError(
      ErrorCodes.CRYPTO_INVALID_PAYLOAD,
      `encryptedData exceeds ${MAX_ENCRYPTED_DATA_BYTES} byte limit`,
      400
    )
  }

  const signature = safeBase64Decode(item.signature)
  if (signature.length !== ED25519_PARAMS.SIGNATURE_LENGTH) {
    throw new AppError(
      ErrorCodes.CRYPTO_INVALID_PAYLOAD,
      `signature must be ${ED25519_PARAMS.SIGNATURE_LENGTH} bytes, got ${signature.length}`,
      400
    )
  }
}

export const verifyItemSignature = async (
  db: D1Database,
  item: PushItemInput,
  userId: string
): Promise<void> => {
  const device = await getDevice(db, item.signerDeviceId, userId)
  if (!device) {
    throw new AppError(ErrorCodes.AUTH_DEVICE_NOT_FOUND, 'Signer device not found', 404)
  }
  if (device.revoked_at) {
    throw new AppError(ErrorCodes.AUTH_DEVICE_REVOKED, 'Signer device has been revoked', 403)
  }

  const signaturePayload: Record<string, unknown> = {
    id: item.id,
    type: item.type,
    operation: item.operation,
    cryptoVersion: CRYPTO_VERSION,
    encryptedKey: item.encryptedKey,
    keyNonce: item.keyNonce,
    encryptedData: item.encryptedData,
    dataNonce: item.dataNonce,
    metadata: {
      ...(item.clock ? { clock: item.clock } : {}),
      ...(item.stateVector ? { stateVector: item.stateVector } : {})
    }
  }

  if (!item.clock && !item.stateVector) {
    delete signaturePayload.metadata
  }

  if (item.deletedAt !== undefined) {
    signaturePayload.deletedAt = item.deletedAt
  }

  const cborBytes = encodeSignaturePayload(signaturePayload, 'SYNC_ITEM')
  const valid = await verifyEd25519(device.auth_public_key, item.signature, cborBytes)
  if (!valid) {
    throw new AppError(ErrorCodes.SYNC_INVALID_SIGNATURE, 'Item signature verification failed', 403)
  }
}

export const detectReplay = (incoming?: VectorClock, existing?: VectorClock): boolean => {
  if (existing && !incoming) return true
  if (!incoming || !existing) return false

  for (const key of Object.keys(incoming)) {
    const inVal = incoming[key] ?? 0
    const exVal = existing[key] ?? 0
    if (inVal > exVal) return false
  }

  return true
}

export const computeContentHash = async (payload: {
  dataNonce: string
  encryptedData: string
  encryptedKey: string
  keyNonce: string
}): Promise<string> => {
  const canonical = JSON.stringify(payload, Object.keys(payload).sort())
  const bytes = new TextEncoder().encode(canonical)
  const hash = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export const serializePayload = (item: PushItemInput): string => {
  const payload = {
    dataNonce: item.dataNonce,
    encryptedData: item.encryptedData,
    encryptedKey: item.encryptedKey,
    keyNonce: item.keyNonce
  }
  return JSON.stringify(payload, Object.keys(payload).sort())
}

const estimatePushBatchBytes = (items: PushItemInput[]): number => JSON.stringify(items).length

const parseStoredClock = (itemId: string, clock: string | null): VectorClock | undefined => {
  if (!clock) {
    return undefined
  }

  try {
    return JSON.parse(clock) as VectorClock
  } catch {
    throw new AppError(ErrorCodes.INTERNAL_ERROR, `Corrupt clock payload for item ${itemId}`, 500)
  }
}

const readEncryptedPayload = async (
  storage: R2Bucket,
  blobKey: string,
  userId: string,
  itemId: string
): Promise<EncryptedItemPayload> => {
  const blob = await getBlob(storage, blobKey, userId)
  if (!blob) {
    throw new AppError(
      ErrorCodes.STORAGE_BLOB_NOT_FOUND,
      `Blob missing for item ${itemId}`,
      404
    )
  }

  try {
    const text = await new Response(blob.body).text()
    return JSON.parse(text) as EncryptedItemPayload
  } catch {
    throw new AppError(ErrorCodes.INTERNAL_ERROR, `Corrupt blob payload for item ${itemId}`, 500)
  }
}

const toPullItemResponse = async (
  storage: R2Bucket,
  userId: string,
  row: StoredSyncItemPullRow
): Promise<PullItemResponse> => {
  const payload = await readEncryptedPayload(storage, row.blob_key, userId, row.item_id)

  if (!row.signer_device_id || !row.signature) {
    throw new AppError(
      ErrorCodes.INTERNAL_ERROR,
      `Sync item ${row.item_id} missing signer metadata`,
      500
    )
  }

  const parsedClock = parseStoredClock(row.item_id, row.clock)

  return {
    id: row.item_id,
    type: row.item_type as PullItemResponse['type'],
    operation: row.operation as PullItemResponse['operation'],
    cryptoVersion: row.crypto_version,
    signature: row.signature,
    signerDeviceId: row.signer_device_id,
    ...(row.deleted_at ? { deletedAt: row.deleted_at } : {}),
    ...(parsedClock ? { clock: parsedClock } : {}),
    ...(row.state_vector ? { stateVector: row.state_vector } : {}),
    blob: payload
  }
}

export const processRecordPushBatch = async (
  db: D1Database,
  storage: R2Bucket,
  userId: string,
  deviceId: string,
  items: PushItemInput[]
): Promise<RecordPushBatchResult> => {
  await checkQuota(db, userId, estimatePushBatchBytes(items))

  const accepted: string[] = []
  const rejected: Array<{ id: string; reason: string }> = []
  const outcomes: RecordPushBatchOutcome[] = []
  let maxCursor = 0

  for (const item of items) {
    const result = await processPushItem(db, storage, userId, deviceId, item)
    outcomes.push({
      id: item.id,
      type: item.type,
      accepted: result.accepted,
      reason: result.reason,
      serverCursor: result.serverCursor
    })

    if (result.accepted) {
      accepted.push(item.id)
      if (result.serverCursor && result.serverCursor > maxCursor) {
        maxCursor = result.serverCursor
      }
      continue
    }

    rejected.push({ id: item.id, reason: result.reason ?? 'UNKNOWN' })
  }

  return {
    accepted,
    rejected,
    serverTime: Math.floor(Date.now() / 1000),
    maxCursor,
    outcomes
  }
}

export const processPushItem = async (
  db: D1Database,
  storage: R2Bucket,
  userId: string,
  deviceId: string,
  item: PushItemInput
): Promise<{ accepted: boolean; reason?: string; serverCursor?: number }> => {
  try {
    validateEncryptedFields(item)
    await verifyItemSignature(db, item, userId)

    const existing = await db
      .prepare('SELECT * FROM sync_items WHERE user_id = ? AND item_type = ? AND item_id = ?')
      .bind(userId, item.type, item.id)
      .first<ExistingSyncItemRow>()

    if (existing) {
      const existingClock =
        typeof existing.clock === 'string'
          ? (JSON.parse(existing.clock) as VectorClock)
          : (existing.clock ?? undefined)
      if (detectReplay(item.clock, existingClock)) {
        return { accepted: false, reason: 'SYNC_REPLAY_DETECTED' }
      }
    }

    const version = existing ? existing.version + 1 : 1
    const payloadString = serializePayload(item)
    const payloadBytes = new TextEncoder().encode(payloadString)
    const contentHash = await computeContentHash({
      dataNonce: item.dataNonce,
      encryptedData: item.encryptedData,
      encryptedKey: item.encryptedKey,
      keyNonce: item.keyNonce
    })

    const newSize = payloadBytes.byteLength
    const existingSize = existing ? (existing.size_bytes ?? 0) : 0
    const sizeDelta = newSize - existingSize

    if (sizeDelta > 0) {
      const user = await getUserById(db, userId)
      if (!user) {
        return { accepted: false, reason: ErrorCodes.AUTH_INVALID_TOKEN }
      }
      if (user.storage_used + sizeDelta > user.storage_limit) {
        return { accepted: false, reason: ErrorCodes.STORAGE_QUOTA_EXCEEDED }
      }
    }

    const blobKey = generateBlobKey(userId, item.id)
    await putBlob(storage, blobKey, payloadBytes.slice().buffer, userId)

    const serverCursor = await getNextCursor(db, userId)
    const now = Math.floor(Date.now() / 1000)
    const deletedAt = item.operation === 'delete' ? (item.deletedAt ?? now) : null
    const clockJson = item.clock ? JSON.stringify(item.clock) : null

    const existingCreatedAt = existing?.created_at ?? existing?.createdAt ?? now

    const upsertSyncItemStmt = db
      .prepare(
        `INSERT INTO sync_items (
          id, user_id, item_type, item_id, blob_key, size_bytes, content_hash,
          version, crypto_version, operation, server_cursor, signer_device_id, signature,
          state_vector, clock, created_at, updated_at, deleted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (user_id, item_type, item_id) DO UPDATE SET
          blob_key = excluded.blob_key,
          size_bytes = excluded.size_bytes,
          content_hash = excluded.content_hash,
          version = excluded.version,
          crypto_version = excluded.crypto_version,
          operation = excluded.operation,
          server_cursor = excluded.server_cursor,
          signer_device_id = excluded.signer_device_id,
          signature = excluded.signature,
          state_vector = excluded.state_vector,
          clock = excluded.clock,
          updated_at = excluded.updated_at,
          deleted_at = excluded.deleted_at`
      )
      .bind(
        crypto.randomUUID(),
        userId,
        item.type,
        item.id,
        blobKey,
        payloadBytes.byteLength,
        contentHash,
        version,
        CRYPTO_VERSION,
        item.operation,
        serverCursor,
        item.signerDeviceId,
        item.signature,
        item.stateVector ?? null,
        clockJson,
        existingCreatedAt,
        now,
        deletedAt
      )

    const transactionalStatements = [upsertSyncItemStmt]
    if (sizeDelta !== 0) {
      const updateStorageStmt = db
        .prepare('UPDATE users SET storage_used = MAX(0, storage_used + ?) WHERE id = ?')
        .bind(sizeDelta, userId)
      transactionalStatements.push(updateStorageStmt)
    }

    await db.batch(transactionalStatements)

    return { accepted: true, serverCursor }
  } catch (error) {
    if (error instanceof AppError) {
      return { accepted: false, reason: error.code }
    }
    return { accepted: false, reason: 'INTERNAL_ERROR' }
  }
}

export const updateDeviceCursor = async (
  db: D1Database,
  deviceId: string,
  userId: string,
  cursor: number
): Promise<void> => {
  await db
    .prepare(
      `INSERT INTO device_sync_state (device_id, user_id, last_cursor_seen, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (device_id, user_id) DO UPDATE SET
         last_cursor_seen = MAX(device_sync_state.last_cursor_seen, excluded.last_cursor_seen),
         updated_at = excluded.updated_at`
    )
    .bind(deviceId, userId, cursor, Math.floor(Date.now() / 1000))
    .run()
}

export const getSyncStatus = async (
  db: D1Database,
  userId: string,
  deviceId: string
): Promise<SyncStatus> => {
  const deviceState = await db
    .prepare(
      'SELECT last_cursor_seen, updated_at FROM device_sync_state WHERE device_id = ? AND user_id = ?'
    )
    .bind(deviceId, userId)
    .first<{ last_cursor_seen: number; updated_at: number }>()

  const lastCursor = deviceState?.last_cursor_seen ?? 0

  const pending = await db
    .prepare('SELECT COUNT(*) as count FROM sync_items WHERE user_id = ? AND server_cursor > ?')
    .bind(userId, lastCursor)
    .first<{ count: number }>()

  return {
    connected: true,
    lastSyncAt: deviceState?.updated_at,
    pendingItems: pending?.count ?? 0,
    serverTime: Math.floor(Date.now() / 1000)
  }
}

export const getManifest = async (db: D1Database, userId: string): Promise<SyncManifest> => {
  const rows = await db
    .prepare(
      `SELECT item_id, item_type, version, updated_at, size_bytes, state_vector
       FROM sync_items
       WHERE user_id = ? AND deleted_at IS NULL
       ORDER BY server_cursor ASC`
    )
    .bind(userId)
    .all<{
      item_id: string
      item_type: string
      version: number
      updated_at: number
      size_bytes: number
      state_vector: string | null
    }>()

  const items: SyncItemRef[] = (rows.results ?? []).map((row) => ({
    id: row.item_id,
    type: row.item_type as SyncItemRef['type'],
    version: row.version,
    modifiedAt: row.updated_at,
    size: row.size_bytes,
    ...(row.state_vector ? { stateVector: row.state_vector } : {})
  }))

  return { items, serverTime: Math.floor(Date.now() / 1000) }
}

export const getChanges = async (
  db: D1Database,
  userId: string,
  cursor: number,
  limit?: number
): Promise<ChangesResponse> => {
  const effectiveLimit = Math.min(limit ?? DEFAULT_CHANGES_LIMIT, MAX_CHANGES_LIMIT)

  const rows = await db
    .prepare(
      `SELECT item_id, item_type, version, updated_at, size_bytes, state_vector, server_cursor, deleted_at
       FROM sync_items
       WHERE user_id = ? AND server_cursor > ?
       ORDER BY server_cursor ASC
       LIMIT ?`
    )
    .bind(userId, cursor, effectiveLimit + 1)
    .all<{
      item_id: string
      item_type: string
      version: number
      updated_at: number
      size_bytes: number
      state_vector: string | null
      server_cursor: number
      deleted_at: number | null
    }>()

  const allRows = rows.results ?? []
  const hasMore = allRows.length > effectiveLimit
  const pageRows = hasMore ? allRows.slice(0, effectiveLimit) : allRows

  const items: SyncItemRef[] = []
  const deleted: string[] = []

  for (const row of pageRows) {
    if (row.deleted_at) {
      deleted.push(row.item_id)
    } else {
      items.push({
        id: row.item_id,
        type: row.item_type as SyncItemRef['type'],
        version: row.version,
        modifiedAt: row.updated_at,
        size: row.size_bytes,
        ...(row.state_vector ? { stateVector: row.state_vector } : {})
      })
    }
  }

  const lastRow = pageRows[pageRows.length - 1]
  const nextCursor = lastRow?.server_cursor ?? cursor

  return { items, deleted, hasMore, nextCursor }
}

const D1_MAX_BIND_PARAMS = 95

export const pullItems = async (
  db: D1Database,
  storage: R2Bucket,
  userId: string,
  itemIds: string[]
): Promise<PullItemResponse[]> => {
  if (itemIds.length === 0) {
    return []
  }

  const BATCH_SIZE = D1_MAX_BIND_PARAMS - 1

  const allDbRows: StoredSyncItemPullRow[] = []

  for (let i = 0; i < itemIds.length; i += BATCH_SIZE) {
    const batch = itemIds.slice(i, i + BATCH_SIZE)
    const placeholders = batch.map(() => '?').join(', ')
    const rows = await db
      .prepare(
        `SELECT item_id, item_type, blob_key, crypto_version, operation, signer_device_id, signature,
                state_vector, clock, deleted_at, server_cursor
         FROM sync_items
         WHERE user_id = ? AND item_id IN (${placeholders})
         ORDER BY server_cursor ASC`
      )
      .bind(userId, ...batch)
      .all<StoredSyncItemPullRow>()
    allDbRows.push(...(rows.results ?? []))
  }

  allDbRows.sort((a, b) => a.server_cursor - b.server_cursor)

  const results: PullItemResponse[] = []

  for (const row of allDbRows) {
    results.push(await toPullItemResponse(storage, userId, row))
  }

  return results
}

export const getItem = async (
  db: D1Database,
  storage: R2Bucket,
  userId: string,
  itemId: string
): Promise<{
  itemId: string
  type: string
  version: number
  payload: EncryptedItemPayload
  serverCursor: number
}> => {
  const row = await db
    .prepare(
      `SELECT item_id, item_type, version, blob_key, server_cursor
       FROM sync_items
       WHERE user_id = ? AND item_id = ? AND deleted_at IS NULL`
    )
    .bind(userId, itemId)
    .first<{
      item_id: string
      item_type: string
      version: number
      blob_key: string
      server_cursor: number
    }>()

  if (!row) {
    throw new AppError(ErrorCodes.SYNC_ITEM_NOT_FOUND, 'Sync item not found', 404)
  }

  const payload = await readEncryptedPayload(storage, row.blob_key, userId, itemId)

  return {
    itemId: row.item_id,
    type: row.item_type,
    version: row.version,
    payload,
    serverCursor: row.server_cursor
  }
}

export { DEFAULT_CHANGES_LIMIT, MAX_CHANGES_LIMIT, MAX_ENCRYPTED_DATA_BYTES }
