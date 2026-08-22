import { CRYPTO_VERSION, ED25519_PARAMS, XCHACHA20_PARAMS } from '@memry/contracts/crypto'
import type {
  EncryptedItemPayload,
  PushItemInput,
  PushResponse,
  SyncStatus,
  VectorClock,
  RecordChangesResponse,
  RecordPullItemResponse,
  RecordSyncItemType,
  RecordSyncManifest
} from '@memry/contracts/sync-api'
import {
  LEGACY_RECORD_SYNC_ITEM_TYPES,
  RECORD_CLOCK_REQUIRED_ITEM_TYPES,
  RECORD_SYNC_ITEM_TYPES
} from '@memry/contracts/sync-api'
import { encodeSignaturePayload } from '../lib/cbor'
import type { ClientIdentity } from '../lib/client-identity'
import { safeBase64Decode, verifyEd25519 } from '../lib/encoding'
import { AppError, ErrorCodes } from '../lib/errors'
import { deleteBlob, generateItemBlobKey, getBlob, putBlob } from './blob'
import { getNextCursor } from './cursor'
import { getDevice } from './device'
import { adjustStorageUsed, checkQuota, reserveStorage } from './quota'

const MAX_ENCRYPTED_DATA_BYTES = 5 * 1024 * 1024
const DEFAULT_CHANGES_LIMIT = 100
const MAX_CHANGES_LIMIT = 500
const RECORD_SYNC_ITEM_TYPE_SET = new Set<RecordSyncItemType>(RECORD_SYNC_ITEM_TYPES)
const RECORD_CLOCK_REQUIRED_TYPE_SET = new Set<RecordSyncItemType>(RECORD_CLOCK_REQUIRED_ITEM_TYPES)

const placeholdersFor = (types: readonly RecordSyncItemType[]): string =>
  types.map(() => '?').join(', ')

interface ExistingSyncItemRow {
  version: number
  clock: string | VectorClock | null
  blob_key?: string | null
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

const isSupportedRecordSyncItemType = (type: string): type is RecordSyncItemType =>
  RECORD_SYNC_ITEM_TYPE_SET.has(type as RecordSyncItemType)

const requiresRecordClock = (type: RecordSyncItemType): boolean =>
  RECORD_CLOCK_REQUIRED_TYPE_SET.has(type)

export const shouldRejectRecordReplay = (
  itemType: PushItemInput['type'],
  incoming?: VectorClock,
  existing?: VectorClock
): boolean => {
  if (!isSupportedRecordSyncItemType(itemType)) {
    return false
  }
  if (!requiresRecordClock(itemType)) {
    return false
  }
  return detectReplay(incoming, existing)
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
    throw new AppError(ErrorCodes.STORAGE_BLOB_NOT_FOUND, `Blob missing for item ${itemId}`, 404)
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
): Promise<RecordPullItemResponse | null> => {
  if (!isSupportedRecordSyncItemType(row.item_type)) {
    return null
  }

  let payload: EncryptedItemPayload
  try {
    payload = await readEncryptedPayload(storage, row.blob_key, userId, row.item_id)
  } catch (error) {
    // A missing object must cost only this row, not the page: one dangling row
    // (or the transient window where a replacing push just deleted the blob
    // this row version pointed at) used to reject the whole Promise.all, so
    // every pull retry failed on the same item and the client cursor never
    // advanced. Skipping is safe — a replaced item re-arrives at a later
    // cursor, and a genuinely dangling row has no bytes to deliver anyway.
    if (error instanceof AppError && error.code === ErrorCodes.STORAGE_BLOB_NOT_FOUND) {
      return null
    }
    throw error
  }

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
    type: row.item_type,
    operation: row.operation as RecordPullItemResponse['operation'],
    cryptoVersion: row.crypto_version,
    signature: row.signature,
    signerDeviceId: row.signer_device_id,
    ...(row.deleted_at ? { deletedAt: row.deleted_at } : {}),
    ...(parsedClock ? { clock: parsedClock } : {}),
    blob: payload
  }
}

export const processRecordPushBatch = async (
  db: D1Database,
  storage: R2Bucket,
  userId: string,
  deviceId: string,
  items: PushItemInput[],
  vaultId = 'default',
  client: ClientIdentity | null = null
): Promise<RecordPushBatchResult> => {
  await checkQuota(db, userId, estimatePushBatchBytes(items))

  const accepted: string[] = []
  const rejected: Array<{ id: string; reason: string }> = []
  const outcomes: RecordPushBatchOutcome[] = []
  let maxCursor = 0

  for (const item of items) {
    const result = await processPushItem(db, storage, userId, deviceId, item, vaultId, client)
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
  item: PushItemInput,
  vaultId = 'default',
  client: ClientIdentity | null = null
): Promise<{ accepted: boolean; reason?: string; serverCursor?: number }> => {
  try {
    if (!isSupportedRecordSyncItemType(item.type)) {
      return { accepted: false, reason: ErrorCodes.VALIDATION_ERROR }
    }
    if (requiresRecordClock(item.type) && item.clock === undefined) {
      return { accepted: false, reason: ErrorCodes.VALIDATION_ERROR }
    }
    if (item.stateVector !== undefined) {
      return { accepted: false, reason: ErrorCodes.VALIDATION_ERROR }
    }

    validateEncryptedFields(item)
    await verifyItemSignature(db, item, userId)

    const existing = await db
      .prepare(
        'SELECT * FROM sync_items WHERE user_id = ? AND vault_id = ? AND item_type = ? AND item_id = ?'
      )
      .bind(userId, vaultId, item.type, item.id)
      .first<ExistingSyncItemRow>()

    if (existing) {
      const existingClock =
        typeof existing.clock === 'string'
          ? (JSON.parse(existing.clock) as VectorClock)
          : (existing.clock ?? undefined)
      if (shouldRejectRecordReplay(item.type, item.clock, existingClock)) {
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

    let reservedBytes = 0
    if (sizeDelta > 0) {
      await reserveStorage(db, userId, sizeDelta)
      reservedBytes = sizeDelta
    }

    const blobKey = generateItemBlobKey(userId, item.type, item.id, vaultId, contentHash)
    try {
      await putBlob(storage, blobKey, payloadBytes.slice().buffer, userId)
    } catch (error) {
      if (reservedBytes > 0) {
        await adjustStorageUsed(db, userId, -reservedBytes)
      }
      throw error
    }

    const serverCursor = await getNextCursor(db, userId)
    const now = Math.floor(Date.now() / 1000)
    const deletedAt = item.operation === 'delete' ? (item.deletedAt ?? now) : null
    const clockJson = item.clock ? JSON.stringify(item.clock) : null

    const existingCreatedAt = existing?.created_at ?? existing?.createdAt ?? now

    const upsertSyncItemStmt = db
      .prepare(
        `INSERT INTO sync_items (
          id, user_id, vault_id, item_type, item_id, blob_key, size_bytes, content_hash,
          version, crypto_version, operation, server_cursor, signer_device_id, signature,
          state_vector, clock, created_at, updated_at, deleted_at,
          client_platform, client_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (user_id, vault_id, item_type, item_id) DO UPDATE SET
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
          deleted_at = excluded.deleted_at,
          -- Attribution tracks the LATEST writer, not the creator: an incident
          -- query asks "what did iOS write", and a desktop rewrite of the same
          -- row is no longer a mobile-originated value.
          client_platform = excluded.client_platform,
          client_version = excluded.client_version`
      )
      .bind(
        crypto.randomUUID(),
        userId,
        vaultId,
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
        deletedAt,
        client?.platform ?? null,
        client?.version ?? null
      )

    const transactionalStatements = [upsertSyncItemStmt]
    if (sizeDelta < 0) {
      const updateStorageStmt = db
        .prepare('UPDATE users SET storage_used = MAX(0, storage_used + ?) WHERE id = ?')
        .bind(sizeDelta, userId)
      transactionalStatements.push(updateStorageStmt)
    }

    try {
      await db.batch(transactionalStatements)
    } catch (error) {
      if (reservedBytes > 0) {
        await adjustStorageUsed(db, userId, -reservedBytes)
      }
      throw error
    }

    // The row now points at the new content-addressed object, so the previous
    // version's blob is unreachable through any row and can go. Best-effort: a
    // failed delete leaks one bounded orphan object, never a dangling row. An
    // in-flight pull that read the old row before this upsert may 404 on the
    // old key; the pull path tolerates that per item, and the replacement row
    // re-arrives at a later cursor.
    if (existing?.blob_key && existing.blob_key !== blobKey) {
      try {
        await deleteBlob(storage, existing.blob_key, userId)
      } catch {
        // Orphans are invisible to readers; acceptable until a sweep job exists.
      }
    }

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
  cursor: number,
  vaultId = 'default'
): Promise<void> => {
  await db
    .prepare(
      `INSERT INTO device_sync_state (device_id, user_id, vault_id, last_cursor_seen, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (device_id, user_id, vault_id) DO UPDATE SET
         last_cursor_seen = MAX(device_sync_state.last_cursor_seen, excluded.last_cursor_seen),
         updated_at = excluded.updated_at`
    )
    .bind(deviceId, userId, vaultId, cursor, Math.floor(Date.now() / 1000))
    .run()
}

export const getSyncStatus = async (
  db: D1Database,
  userId: string,
  deviceId: string,
  vaultId = 'default'
): Promise<SyncStatus> => {
  const deviceState = await db
    .prepare(
      'SELECT last_cursor_seen, updated_at FROM device_sync_state WHERE device_id = ? AND user_id = ? AND vault_id = ?'
    )
    .bind(deviceId, userId, vaultId)
    .first<{ last_cursor_seen: number; updated_at: number }>()

  const lastCursor = deviceState?.last_cursor_seen ?? 0

  const pending = await db
    .prepare(
      'SELECT COUNT(*) as count FROM sync_items WHERE user_id = ? AND vault_id = ? AND server_cursor > ?'
    )
    .bind(userId, vaultId, lastCursor)
    .first<{ count: number }>()

  return {
    connected: true,
    lastSyncAt: deviceState?.updated_at,
    pendingItems: pending?.count ?? 0,
    serverTime: Math.floor(Date.now() / 1000)
  }
}

export const getManifest = async (
  db: D1Database,
  userId: string,
  vaultId = 'default',
  types: readonly RecordSyncItemType[] = LEGACY_RECORD_SYNC_ITEM_TYPES
): Promise<RecordSyncManifest> => {
  if (types.length === 0) {
    return { items: [], serverTime: Math.floor(Date.now() / 1000) }
  }

  const rows = await db
    .prepare(
      `SELECT item_id, item_type, version, updated_at, size_bytes, state_vector
       FROM sync_items
       WHERE user_id = ? AND vault_id = ? AND deleted_at IS NULL AND item_type IN (${placeholdersFor(types)})
       ORDER BY server_cursor ASC`
    )
    .bind(userId, vaultId, ...types)
    .all<{
      item_id: string
      item_type: string
      version: number
      updated_at: number
      size_bytes: number
      state_vector: string | null
    }>()

  const items = (rows.results ?? [])
    .filter((row) => isSupportedRecordSyncItemType(row.item_type))
    .map((row) => ({
      id: row.item_id,
      type: row.item_type as RecordSyncItemType,
      version: row.version,
      modifiedAt: row.updated_at,
      size: row.size_bytes
    }))

  return { items, serverTime: Math.floor(Date.now() / 1000) }
}

export const getChanges = async (
  db: D1Database,
  userId: string,
  cursor: number,
  limit?: number,
  vaultId = 'default',
  types: readonly RecordSyncItemType[] = LEGACY_RECORD_SYNC_ITEM_TYPES
): Promise<RecordChangesResponse> => {
  if (types.length === 0) {
    return { items: [], deleted: [], hasMore: false, nextCursor: cursor }
  }

  const effectiveLimit = Math.min(limit ?? DEFAULT_CHANGES_LIMIT, MAX_CHANGES_LIMIT)

  const rows = await db
    .prepare(
      `SELECT item_id, item_type, version, updated_at, size_bytes, state_vector, server_cursor, deleted_at
       FROM sync_items
       WHERE user_id = ? AND vault_id = ? AND server_cursor > ? AND item_type IN (${placeholdersFor(types)})
       ORDER BY server_cursor ASC
       LIMIT ?`
    )
    .bind(userId, vaultId, cursor, ...types, effectiveLimit + 1)
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

  const items: RecordChangesResponse['items'] = []
  const deleted: string[] = []

  for (const row of pageRows) {
    if (!isSupportedRecordSyncItemType(row.item_type)) {
      continue
    }
    if (row.deleted_at) {
      deleted.push(row.item_id)
    } else {
      items.push({
        id: row.item_id,
        type: row.item_type,
        version: row.version,
        modifiedAt: row.updated_at,
        size: row.size_bytes
      })
    }
  }

  const lastRow = pageRows[pageRows.length - 1]
  const nextCursor = lastRow?.server_cursor ?? cursor

  return { items, deleted, hasMore, nextCursor }
}

export interface UserVaultSummary {
  vaultUuid: string
  itemCount: number
  createdAt: number | null
  encryptedName: string | null
  nameNonce: string | null
}

export const listUserVaults = async (
  db: D1Database,
  userId: string
): Promise<UserVaultSummary[]> => {
  const { results } = await db
    .prepare(
      `SELECT sv.vault_id AS vaultUuid,
              COALESCE(cnt.itemCount, 0) AS itemCount,
              sv.created_at AS createdAt,
              sv.encrypted_name AS encryptedName,
              sv.name_nonce AS nameNonce
       FROM sync_vaults sv
       LEFT JOIN (
         SELECT user_id, vault_id, COUNT(*) AS itemCount
         FROM sync_items
         WHERE deleted_at IS NULL
         GROUP BY user_id, vault_id
       ) cnt ON cnt.user_id = sv.user_id AND cnt.vault_id = sv.vault_id
       WHERE sv.user_id = ?
       ORDER BY itemCount DESC`
    )
    .bind(userId)
    .all<UserVaultSummary>()
  return (results ?? []).map((r) => ({
    vaultUuid: r.vaultUuid,
    itemCount: Number(r.itemCount),
    createdAt: r.createdAt ?? null,
    encryptedName: r.encryptedName ?? null,
    nameNonce: r.nameNonce ?? null
  }))
}

export const setVaultName = async (
  db: D1Database,
  userId: string,
  vaultId: string,
  encryptedName: string,
  nameNonce: string
): Promise<void> => {
  await db
    .prepare(
      `UPDATE sync_vaults SET encrypted_name = ?, name_nonce = ?, updated_at = ?
       WHERE user_id = ? AND vault_id = ?`
    )
    .bind(encryptedName, nameNonce, Math.floor(Date.now() / 1000), userId, vaultId)
    .run()
}

const D1_MAX_BIND_PARAMS = 95

// Upper bound on simultaneous R2 reads from pullItems. Conservative for a
// Worker (avoids firing hundreds of subrequests at once); tune here if needed.
const R2_CONCURRENCY = 25

export const pullItems = async (
  db: D1Database,
  storage: R2Bucket,
  userId: string,
  itemIds: string[],
  vaultId = 'default',
  types: readonly RecordSyncItemType[] = LEGACY_RECORD_SYNC_ITEM_TYPES
): Promise<RecordPullItemResponse[]> => {
  if (itemIds.length === 0 || types.length === 0) {
    return []
  }

  // 95 D1 bind params, minus user_id + vault_id, minus one per negotiated type.
  const BATCH_SIZE = D1_MAX_BIND_PARAMS - 2 - types.length

  const allDbRows: StoredSyncItemPullRow[] = []

  for (let i = 0; i < itemIds.length; i += BATCH_SIZE) {
    const batch = itemIds.slice(i, i + BATCH_SIZE)
    const placeholders = batch.map(() => '?').join(', ')
    const rows = await db
      .prepare(
        `SELECT item_id, item_type, blob_key, crypto_version, operation, signer_device_id, signature,
                state_vector, clock, deleted_at, server_cursor
         FROM sync_items
         WHERE user_id = ? AND vault_id = ? AND item_type IN (${placeholdersFor(types)})
           AND item_id IN (${placeholders})
         ORDER BY server_cursor ASC`
      )
      .bind(userId, vaultId, ...types, ...batch)
      .all<StoredSyncItemPullRow>()
    allDbRows.push(...(rows.results ?? []))
  }

  allDbRows.sort((a, b) => a.server_cursor - b.server_cursor)

  // Fetch encrypted payloads from R2 with bounded concurrency. Map over the
  // already server_cursor-sorted allDbRows in fixed-size windows and concatenate
  // window results in order, so output ordering is preserved while at most
  // R2_CONCURRENCY reads are in flight at once.
  const settled: Array<RecordPullItemResponse | null> = []

  for (let i = 0; i < allDbRows.length; i += R2_CONCURRENCY) {
    const window = allDbRows.slice(i, i + R2_CONCURRENCY)
    const part = await Promise.all(window.map((row) => toPullItemResponse(storage, userId, row)))
    settled.push(...part)
  }

  return settled.filter((item): item is RecordPullItemResponse => item !== null)
}

export const getItem = async (
  db: D1Database,
  storage: R2Bucket,
  userId: string,
  itemId: string,
  vaultId = 'default'
): Promise<{
  itemId: string
  type: RecordSyncItemType
  version: number
  payload: EncryptedItemPayload
  serverCursor: number
}> => {
  const row = await db
    .prepare(
      `SELECT item_id, item_type, version, blob_key, server_cursor
       FROM sync_items
       WHERE user_id = ? AND vault_id = ? AND item_type IN (${placeholdersFor(RECORD_SYNC_ITEM_TYPES)})
         AND item_id = ? AND deleted_at IS NULL`
    )
    .bind(userId, vaultId, ...RECORD_SYNC_ITEM_TYPES, itemId)
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
    type: row.item_type as RecordSyncItemType,
    version: row.version,
    payload,
    serverCursor: row.server_cursor
  }
}

export { DEFAULT_CHANGES_LIMIT, MAX_CHANGES_LIMIT, MAX_ENCRYPTED_DATA_BYTES }
