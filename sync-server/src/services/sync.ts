/**
 * T089, T089a, T089b: Sync Service
 *
 * Core sync operations with D1 database integration.
 * Handles CRUD operations for sync items with signature verification.
 */

import { SyncError, ErrorCode } from '../lib/errors'
import { getNextCursor, getNextCursors, getCurrentCursor } from './cursor'
import { encodeCanonicalCbor } from '../lib/cbor'
import type {
  SyncItemPush,
  SyncItemResponse,
  SyncItemType,
  VectorClock
} from '../contracts/sync-api'

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_STORAGE_LIMIT_BYTES = 1073741824 // 1GB

// =============================================================================
// Types
// =============================================================================

interface SyncItemRow {
  id: string
  user_id: string
  item_type: SyncItemType
  item_id: string
  encrypted_data: ArrayBuffer
  encrypted_key: ArrayBuffer
  key_nonce: ArrayBuffer
  data_nonce: ArrayBuffer
  clock: string | null
  state_vector: string | null
  deleted: number
  crypto_version: number
  size_bytes: number
  content_hash: string
  signer_device_id: string
  signature: ArrayBuffer
  server_cursor: number
  created_at: number
  updated_at: number
}

interface ManifestItem {
  itemId: string
  itemType: SyncItemType
  contentHash: string
  updatedAt: number
  sizeBytes: number
  serverCursor: number
}

interface PushResult {
  accepted: string[]
  rejected: Array<{ itemId: string; reason: string }>
  conflicts: Array<{ itemId: string; serverItem: SyncItemResponse }>
  serverCursor: number
}

interface ChangesResult {
  items: SyncItemResponse[]
  hasMore: boolean
  nextCursor: number
  serverTime: number
}

// =============================================================================
// Helper Functions
// =============================================================================

function arrayBufferToBase64(buffer: ArrayBuffer | null | undefined): string {
  if (!buffer) return ''
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

function rowToResponse(row: SyncItemRow): SyncItemResponse {
  return {
    itemType: row.item_type,
    itemId: row.item_id,
    userId: row.user_id,
    encryptedData: arrayBufferToBase64(row.encrypted_data),
    encryptedKey: arrayBufferToBase64(row.encrypted_key),
    keyNonce: arrayBufferToBase64(row.key_nonce),
    dataNonce: arrayBufferToBase64(row.data_nonce),
    clock: row.clock ? JSON.parse(row.clock) : undefined,
    stateVector: row.state_vector ?? undefined,
    deleted: row.deleted === 1,
    cryptoVersion: row.crypto_version,
    sizeBytes: row.size_bytes,
    contentHash: row.content_hash,
    signerDeviceId: row.signer_device_id,
    signature: arrayBufferToBase64(row.signature),
    serverCursor: row.server_cursor,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

// =============================================================================
// T089b: Signature Verification
// =============================================================================

interface DeviceAuthInfo {
  id: string
  auth_public_key: string
}

async function getDeviceAuthPublicKey(
  db: D1Database,
  deviceId: string,
  userId: string
): Promise<string | null> {
  const device = await db
    .prepare(
      `SELECT id, auth_public_key FROM devices
       WHERE id = ? AND user_id = ? AND auth_public_key != ''`
    )
    .bind(deviceId, userId)
    .first<DeviceAuthInfo>()

  return device?.auth_public_key ?? null
}

function buildSignaturePayload(item: SyncItemPush): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    id: item.itemId,
    type: item.itemType,
    cryptoVersion: item.cryptoVersion,
    encryptedKey: item.encryptedKey,
    keyNonce: item.keyNonce,
    encryptedData: item.encryptedData,
    dataNonce: item.dataNonce
  }

  const metadata: Record<string, unknown> = {}
  if (item.clock) {
    metadata.clock = item.clock
  }
  if (item.fieldClocks) {
    metadata.fieldClocks = item.fieldClocks
  }
  if (item.stateVector) {
    metadata.stateVector = item.stateVector
  }

  if (Object.keys(metadata).length > 0) {
    payload.metadata = metadata
  }

  return payload
}

async function verifyItemSignature(item: SyncItemPush, publicKeyBase64: string): Promise<boolean> {
  try {
    const publicKeyBytes = base64ToUint8Array(publicKeyBase64)
    const signatureBytes = base64ToUint8Array(item.signature)

    const payload = buildSignaturePayload(item)
    const payloadBytes = encodeCanonicalCbor(payload, 'signature-payload-v1')

    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      publicKeyBytes,
      { name: 'Ed25519' },
      false,
      ['verify']
    )

    return await crypto.subtle.verify('Ed25519', cryptoKey, signatureBytes, payloadBytes)
  } catch (error) {
    console.error('Signature verification error:', error)
    return false
  }
}

export async function validateItemSignature(
  db: D1Database,
  userId: string,
  item: SyncItemPush
): Promise<{ valid: boolean; reason?: string }> {
  const publicKey = await getDeviceAuthPublicKey(db, item.signerDeviceId, userId)

  if (!publicKey) {
    return {
      valid: false,
      reason: 'Signer device not found or not authorized'
    }
  }

  const isValid = await verifyItemSignature(item, publicKey)

  if (!isValid) {
    return {
      valid: false,
      reason: 'Invalid signature'
    }
  }

  return { valid: true }
}

// =============================================================================
// T089: Core Sync Operations
// =============================================================================

export async function getSyncItem(
  db: D1Database,
  userId: string,
  itemId: string
): Promise<SyncItemResponse | null> {
  const row = await db
    .prepare(`SELECT * FROM sync_items WHERE user_id = ? AND item_id = ?`)
    .bind(userId, itemId)
    .first<SyncItemRow>()

  return row ? rowToResponse(row) : null
}

export async function getSyncItems(
  db: D1Database,
  userId: string,
  itemIds: string[]
): Promise<SyncItemResponse[]> {
  if (itemIds.length === 0) {
    return []
  }

  const placeholders = itemIds.map(() => '?').join(',')
  const result = await db
    .prepare(
      `SELECT * FROM sync_items
       WHERE user_id = ? AND item_id IN (${placeholders})`
    )
    .bind(userId, ...itemIds)
    .all<SyncItemRow>()

  return (result.results ?? []).map(rowToResponse)
}

export async function getSyncManifest(
  db: D1Database,
  userId: string,
  types?: SyncItemType[]
): Promise<ManifestItem[]> {
  let query = `
    SELECT item_id, item_type, content_hash, updated_at, size_bytes, server_cursor
    FROM sync_items
    WHERE user_id = ? AND deleted = 0
  `
  const params: unknown[] = [userId]

  if (types && types.length > 0) {
    const placeholders = types.map(() => '?').join(',')
    query += ` AND item_type IN (${placeholders})`
    params.push(...types)
  }

  query += ` ORDER BY item_type, item_id`

  const result = await db
    .prepare(query)
    .bind(...params)
    .all<{
      item_id: string
      item_type: SyncItemType
      content_hash: string
      updated_at: number
      size_bytes: number
      server_cursor: number
    }>()

  return (result.results ?? []).map((row) => ({
    itemId: row.item_id,
    itemType: row.item_type,
    contentHash: row.content_hash,
    updatedAt: row.updated_at,
    sizeBytes: row.size_bytes,
    serverCursor: row.server_cursor
  }))
}

export async function getSyncChanges(
  db: D1Database,
  userId: string,
  cursor: number,
  limit: number,
  types?: SyncItemType[]
): Promise<ChangesResult> {
  const effectiveLimit = Math.min(limit, 100) + 1

  let query = `
    SELECT * FROM sync_items
    WHERE user_id = ? AND server_cursor > ?
  `
  const params: unknown[] = [userId, cursor]

  if (types && types.length > 0) {
    const placeholders = types.map(() => '?').join(',')
    query += ` AND item_type IN (${placeholders})`
    params.push(...types)
  }

  query += ` ORDER BY server_cursor LIMIT ?`
  params.push(effectiveLimit)

  const result = await db
    .prepare(query)
    .bind(...params)
    .all<SyncItemRow>()

  const rows = result.results ?? []
  const hasMore = rows.length === effectiveLimit
  const items = hasMore ? rows.slice(0, -1) : rows

  const nextCursor = items.length > 0 ? items[items.length - 1].server_cursor : cursor

  return {
    items: items.map(rowToResponse),
    hasMore,
    nextCursor,
    serverTime: Date.now()
  }
}

export async function upsertSyncItem(
  db: D1Database,
  userId: string,
  item: SyncItemPush,
  serverCursor: number
): Promise<SyncItemResponse> {
  const now = Date.now()
  const id = crypto.randomUUID()

  const encryptedData = base64ToUint8Array(item.encryptedData)
  const encryptedKey = base64ToUint8Array(item.encryptedKey)
  const keyNonce = base64ToUint8Array(item.keyNonce)
  const dataNonce = base64ToUint8Array(item.dataNonce)
  const signature = base64ToUint8Array(item.signature)

  const clockJson = item.clock ? JSON.stringify(item.clock) : null
  const stateVector = item.stateVector ?? null

  await db
    .prepare(
      `INSERT INTO sync_items (
        id, user_id, item_type, item_id, encrypted_data, encrypted_key,
        key_nonce, data_nonce, clock, state_vector, deleted, crypto_version,
        size_bytes, content_hash, signer_device_id, signature, server_cursor,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (user_id, item_type, item_id) DO UPDATE SET
        encrypted_data = excluded.encrypted_data,
        encrypted_key = excluded.encrypted_key,
        key_nonce = excluded.key_nonce,
        data_nonce = excluded.data_nonce,
        clock = excluded.clock,
        state_vector = excluded.state_vector,
        deleted = excluded.deleted,
        crypto_version = excluded.crypto_version,
        size_bytes = excluded.size_bytes,
        content_hash = excluded.content_hash,
        signer_device_id = excluded.signer_device_id,
        signature = excluded.signature,
        server_cursor = excluded.server_cursor,
        updated_at = excluded.updated_at`
    )
    .bind(
      id,
      userId,
      item.itemType,
      item.itemId,
      encryptedData,
      encryptedKey,
      keyNonce,
      dataNonce,
      clockJson,
      stateVector,
      item.deleted ? 1 : 0,
      item.cryptoVersion,
      item.sizeBytes,
      item.contentHash,
      item.signerDeviceId,
      signature,
      serverCursor,
      now,
      now
    )
    .run()

  const savedItem = await getSyncItem(db, userId, item.itemId)
  if (!savedItem) {
    throw new SyncError('Failed to save sync item', ErrorCode.SERVER_DATABASE_ERROR, 500)
  }

  return savedItem
}

export async function softDeleteSyncItem(
  db: D1Database,
  userId: string,
  itemId: string
): Promise<SyncItemResponse | null> {
  const existing = await getSyncItem(db, userId, itemId)
  if (!existing) {
    return null
  }

  const serverCursor = await getNextCursor(db, userId)
  const now = Date.now()

  await db
    .prepare(
      `UPDATE sync_items
       SET deleted = 1, server_cursor = ?, updated_at = ?
       WHERE user_id = ? AND item_id = ?`
    )
    .bind(serverCursor, now, userId, itemId)
    .run()

  return getSyncItem(db, userId, itemId)
}

// =============================================================================
// T089a: Cursor Management & Push Operations
// =============================================================================

export async function pushSyncItems(
  db: D1Database,
  userId: string,
  items: SyncItemPush[]
): Promise<PushResult> {
  const accepted: string[] = []
  const rejected: Array<{ itemId: string; reason: string }> = []
  const conflicts: Array<{ itemId: string; serverItem: SyncItemResponse }> = []

  if (items.length === 0) {
    const currentCursor = await getCurrentCursor(db, userId)
    return { accepted, rejected, conflicts, serverCursor: currentCursor }
  }

  const validItems: SyncItemPush[] = []
  for (const item of items) {
    const validation = await validateItemSignature(db, userId, item)
    if (!validation.valid) {
      rejected.push({ itemId: item.itemId, reason: validation.reason! })
    } else {
      validItems.push(item)
    }
  }

  if (validItems.length === 0) {
    const currentCursor = await getCurrentCursor(db, userId)
    return { accepted, rejected, conflicts, serverCursor: currentCursor }
  }

  const cursors = await getNextCursors(db, userId, validItems.length)
  let storageDelta = 0

  for (let i = 0; i < validItems.length; i++) {
    const item = validItems[i]
    const cursor = cursors[i]

    try {
      const existingItem = await getSyncItem(db, userId, item.itemId)

      if (existingItem && !item.deleted) {
        const hasConflict = detectConflict(existingItem, item)
        if (hasConflict) {
          conflicts.push({ itemId: item.itemId, serverItem: existingItem })
          continue
        }
      }

      await upsertSyncItem(db, userId, item, cursor)
      accepted.push(item.itemId)

      const previousSize = existingItem?.sizeBytes ?? 0
      storageDelta += item.sizeBytes - previousSize
    } catch (error) {
      console.error(`Failed to upsert item ${item.itemId}:`, error)
      rejected.push({
        itemId: item.itemId,
        reason: error instanceof Error ? error.message : 'Unknown error'
      })
    }
  }

  if (storageDelta !== 0) {
    await db
      .prepare(`UPDATE users SET storage_used = storage_used + ? WHERE id = ?`)
      .bind(storageDelta, userId)
      .run()
  }

  const serverCursor = await getCurrentCursor(db, userId)
  return { accepted, rejected, conflicts, serverCursor }
}

function detectConflict(serverItem: SyncItemResponse, clientItem: SyncItemPush): boolean {
  if (serverItem.contentHash === clientItem.contentHash) {
    return false
  }

  if (serverItem.clock && clientItem.clock) {
    return !isClockDominated(serverItem.clock, clientItem.clock)
  }

  return true
}

function isClockDominated(serverClock: VectorClock, clientClock: VectorClock): boolean {
  for (const [deviceId, serverTime] of Object.entries(serverClock)) {
    const clientTime = clientClock[deviceId] ?? 0
    if (clientTime < serverTime) {
      return false
    }
  }
  return true
}

// =============================================================================
// T089a: Device Cursor State
// =============================================================================

export async function updateDeviceCursorState(
  db: D1Database,
  userId: string,
  deviceId: string,
  lastCursorSeen: number
): Promise<void> {
  const now = Date.now()

  await db
    .prepare(
      `INSERT INTO device_sync_state (user_id, device_id, last_cursor_seen, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id, device_id) DO UPDATE SET
         last_cursor_seen = MAX(device_sync_state.last_cursor_seen, excluded.last_cursor_seen),
         updated_at = excluded.updated_at`
    )
    .bind(userId, deviceId, lastCursorSeen, now)
    .run()
}

export async function getDeviceCursorState(
  db: D1Database,
  userId: string,
  deviceId: string
): Promise<number> {
  const result = await db
    .prepare(
      `SELECT last_cursor_seen FROM device_sync_state
       WHERE user_id = ? AND device_id = ?`
    )
    .bind(userId, deviceId)
    .first<{ last_cursor_seen: number }>()

  return result?.last_cursor_seen ?? 0
}

// =============================================================================
// Sync Status
// =============================================================================

export async function getSyncStatus(
  db: D1Database,
  userId: string,
  deviceId: string
): Promise<{
  status: 'healthy' | 'degraded' | 'maintenance'
  serverCursor: number
  pendingItems: number
  lastSyncAt: number | null
  storageUsed: number
  storageLimit: number
}> {
  const serverCursor = await getCurrentCursor(db, userId)
  const deviceCursor = await getDeviceCursorState(db, userId, deviceId)

  const pendingResult = await db
    .prepare(
      `SELECT COUNT(*) as count FROM sync_items
       WHERE user_id = ? AND server_cursor > ?`
    )
    .bind(userId, deviceCursor)
    .first<{ count: number }>()

  const storageResult = await db
    .prepare(`SELECT storage_used, storage_limit FROM users WHERE id = ?`)
    .bind(userId)
    .first<{ storage_used: number; storage_limit: number }>()

  const deviceResult = await db
    .prepare(
      `SELECT updated_at FROM device_sync_state
       WHERE user_id = ? AND device_id = ?`
    )
    .bind(userId, deviceId)
    .first<{ updated_at: number }>()

  return {
    status: 'healthy',
    serverCursor,
    pendingItems: pendingResult?.count ?? 0,
    lastSyncAt: deviceResult?.updated_at ?? null,
    storageUsed: storageResult?.storage_used ?? 0,
    storageLimit: storageResult?.storage_limit ?? DEFAULT_STORAGE_LIMIT_BYTES
  }
}
