import { CRYPTO_VERSION, ED25519_PARAMS, XCHACHA20_PARAMS } from '@memry/contracts/crypto'
import { deleteAttestationPayload, deleteClaimOf } from '@memry/contracts/delete-attestation'
import type {
  EncryptedItemPayload,
  NoteBodyChange,
  PushItemInput,
  PushResponse,
  SyncStatus,
  VectorClock,
  RecordChangesResponse,
  RecordPullBlobMissing,
  RecordPullItemResponse,
  RecordPullPurgedTombstone,
  RecordSyncItemType,
  RecordSyncManifest
} from '@memry/contracts/sync-api'
import {
  LEGACY_RECORD_SYNC_ITEM_TYPES,
  RECORD_CLOCK_REQUIRED_ITEM_TYPES,
  RECORD_SYNC_ITEM_TYPES,
  RECREATABLE_AFTER_PURGE_ITEM_TYPES
} from '@memry/contracts/sync-api'
import { encodeSignaturePayload } from '../lib/cbor'
import type { ClientIdentity } from '../lib/client-identity'
import { safeBase64Decode, verifyEd25519 } from '../lib/encoding'
import { AppError, ErrorCodes } from '../lib/errors'
import { createLogger } from '../lib/logger'
import { LEGACY_SYNC_SUBSCRIPTION, type SyncSubscription } from '../lib/sync-types'
import { deleteBlobs, generateItemBlobKey, getBlob, putBlob } from './blob'
import { readChangePage, type FeedSourceBuilder } from './change-feed'
import { noteBodyFeedSource } from './crdt'
import { reserveCursors } from './cursor'
import { getDevice, type Device } from './device'
import { adjustStorageUsed, reserveStorage } from './quota'

const logger = createLogger('SyncService')

const MAX_ENCRYPTED_DATA_BYTES = 5 * 1024 * 1024
const DEFAULT_CHANGES_LIMIT = 100
const MAX_CHANGES_LIMIT = 500
// A page that carries note bodies inlines update bytes, so it is clamped lower
// than a record-only page (#2295).
const MAX_NOTE_BODY_CHANGES_LIMIT = 100
// D1 hard ceiling is 100 bound parameters per statement; 95 leaves headroom
// for the fixed user_id/vault_id/type columns that ride along with IN lists.
const D1_MAX_BIND_PARAMS = 95
const MAX_MANIFEST_PAGE_LIMIT = 1000
const RECORD_SYNC_ITEM_TYPE_SET = new Set<RecordSyncItemType>(RECORD_SYNC_ITEM_TYPES)
const RECORD_CLOCK_REQUIRED_TYPE_SET = new Set<RecordSyncItemType>(RECORD_CLOCK_REQUIRED_ITEM_TYPES)

const placeholdersFor = (types: readonly RecordSyncItemType[]): string =>
  types.map(() => '?').join(', ')

interface ExistingSyncItemRow {
  item_type: string
  item_id: string
  version: number
  clock: string | VectorClock | null
  blob_key?: string | null
  size_bytes?: number | null
  deleted_at?: number | null
  created_at?: number | null
  createdAt?: number | null
}

interface StoredSyncItemPullRow {
  id: string
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
  /** #2408. Selected by pullItems only; a changes-feed row never needs it. */
  delete_attestation?: string | null
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
  /**
   * The `/sync/pull` item of every row this batch committed, in ascending
   * server cursor order, built from memory (#2300 socket items). Never part of
   * the push response.
   */
  committedItems: RecordPullItemResponse[]
  /** Commit time of the batch's latest committed wave; 0 when nothing committed. */
  committedAtMs: number
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

const verifySignatureWithDevice = async (
  device: Device | null,
  item: PushItemInput
): Promise<Device> => {
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
  return device
}

/**
 * The verified delete attestation to store for `item` (#2408, protocol 04
 * §4.8.4), or null when the write attests nothing: not an attestable delete
 * (deleteClaimOf), or an old client that sent none. One that is present on an
 * attestable delete and does not verify under the signer's key is the item's
 * own SYNC_INVALID_SIGNATURE, like a bad item signature.
 */
const verifyDeleteAttestation = async (
  device: Device,
  item: PushItemInput
): Promise<string | null> => {
  const claim = deleteClaimOf(item)
  if (!claim || item.deleteAttestation === undefined) return null
  const message = encodeSignaturePayload(deleteAttestationPayload(claim), 'DELETE_ATTESTATION')
  const valid = await verifyEd25519(device.auth_public_key, item.deleteAttestation, message).catch(
    () => false
  )
  if (!valid) {
    throw new AppError(
      ErrorCodes.SYNC_INVALID_SIGNATURE,
      'Delete attestation verification failed',
      403
    )
  }
  return item.deleteAttestation
}

export const verifyItemSignature = async (
  db: D1Database,
  item: PushItemInput,
  userId: string
): Promise<void> => {
  const device = await getDevice(db, item.signerDeviceId, userId)
  await verifySignatureWithDevice(device, item)
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

/** True when `incoming` happens strictly after `existing` (dominates every component, exceeds one). */
const happensAfter = (incoming: VectorClock, existing: VectorClock): boolean => {
  let strictlyGreater = false
  for (const key of new Set([...Object.keys(incoming), ...Object.keys(existing)])) {
    const inVal = incoming[key] ?? 0
    const exVal = existing[key] ?? 0
    if (inVal < exVal) return false
    if (inVal > exVal) strictlyGreater = true
  }
  return strictlyGreater
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

/**
 * Delete wins over a concurrent write. `detectReplay` passes as soon as ONE
 * component is ahead, which a device that edited the item before it saw the
 * delete always satisfies — so without this the next write clears the tombstone
 * (`deleted_at = excluded.deleted_at`) and the item returns to every device's
 * manifest. Only a writer that demonstrably saw the delete, meaning its clock
 * happens strictly after the tombstone's, may re-create the id. Types without a
 * required clock, and legacy tombstones stored without one, keep the old
 * behaviour: there is nothing to compare, and refusing them would wedge the id.
 */
export const shouldRejectResurrection = (
  itemType: PushItemInput['type'],
  operation: PushItemInput['operation'],
  existingDeletedAt: number | null | undefined,
  incoming?: VectorClock,
  existing?: VectorClock
): boolean => {
  if (operation === 'delete' || !existingDeletedAt) return false
  if (!isSupportedRecordSyncItemType(itemType) || !requiresRecordClock(itemType)) return false
  if (!incoming || !existing) return false
  return !happensAfter(incoming, existing)
}

/**
 * A purged-tombstone marker (#2302): a deleted row whose payload the cleanup
 * shed. `blob_key = ''` is the marker, not `payload_purged_at`: a worker rolled
 * back past #2302 can write a new version without clearing that timestamp, but
 * never with an empty key.
 */
const isMarkerRow = (row: { deleted_at?: number | null; blob_key?: string | null }): boolean =>
  Boolean(row.deleted_at) && row.blob_key === ''

/** SQL for "this row is not a marker", the same predicate as isMarkerRow. */
const NOT_A_MARKER_SQL = "(deleted_at IS NULL OR blob_key <> '')"

const RECREATABLE_AFTER_PURGE_TYPE_SET = new Set<string>(RECREATABLE_AFTER_PURGE_ITEM_TYPES)

/**
 * A `create` over a purged-tombstone marker (#2302) of a recreatable type is a
 * user re-creating or restoring the thing, with a fresh clock that the old
 * tombstone's clock dominates. Before markers the purge deleted the row and
 * such a create landed; a marker must not refuse it forever. It is accepted as
 * a new version, skipping replay and delete-wins. Within retention (payload not
 * yet shed), `update`/`delete`, and every other type keep the tombstone rules.
 */
const isRecreateOverMarker = (
  item: Pick<PushItemInput, 'type' | 'operation'>,
  existing: Pick<ExistingSyncItemRow, 'deleted_at' | 'blob_key'>
): boolean =>
  item.operation === 'create' &&
  isMarkerRow(existing) &&
  RECREATABLE_AFTER_PURGE_TYPE_SET.has(item.type)

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

/** The stored columns a `/sync/pull` item is made of, already narrowed. */
interface PullItemColumns {
  id: string
  type: RecordSyncItemType
  operation: string
  cryptoVersion: number
  signature: string
  signerDeviceId: string
  deletedAt: number | null
  clock: string | null
}

/**
 * The one constructor of a `/sync/pull` item. The pull feeds it a D1 row and
 * the R2 object; a push feeds it the values it just committed, so a socket
 * item (#2300) is byte-identical to what `/sync/pull` returns for that row.
 */
const pullItemFromColumns = (
  columns: PullItemColumns,
  payload: EncryptedItemPayload
): RecordPullItemResponse => {
  const parsedClock = parseStoredClock(columns.id, columns.clock)
  return {
    id: columns.id,
    type: columns.type,
    operation: columns.operation as RecordPullItemResponse['operation'],
    cryptoVersion: columns.cryptoVersion,
    signature: columns.signature,
    signerDeviceId: columns.signerDeviceId,
    ...(columns.deletedAt ? { deletedAt: columns.deletedAt } : {}),
    ...(parsedClock ? { clock: parsedClock } : {}),
    blob: payload
  }
}

/**
 * What one sync_items row contributes to a POST /sync/pull response (#2302).
 * `blob_not_found` is a live row whose object 404'd: pullItems tells a lost
 * blob from a row replaced since it was read. `omit` is an unsupported type.
 */
type PullRowOutcome =
  | { kind: 'item'; item: RecordPullItemResponse }
  | { kind: 'purged_tombstone'; entry: RecordPullPurgedTombstone }
  | { kind: 'blob_not_found' }
  | { kind: 'omit' }

const purgedTombstoneEntry = (
  row: StoredSyncItemPullRow & { item_type: RecordSyncItemType; deleted_at: number }
): RecordPullPurgedTombstone => {
  const clock = parseStoredClock(row.item_id, row.clock)
  // #2408: served only whole. A client verifies it against the key of the
  // named signer, so an attestation without a signer is no attestation.
  const { signer_device_id: signerDeviceId, delete_attestation: deleteAttestation } = row
  return {
    id: row.item_id,
    type: row.item_type,
    deletedAt: row.deleted_at,
    ...(clock ? { clock } : {}),
    serverCursor: row.server_cursor,
    ...(signerDeviceId && deleteAttestation ? { signerDeviceId, deleteAttestation } : {})
  }
}

const readPullRow = async (
  storage: R2Bucket,
  userId: string,
  row: StoredSyncItemPullRow
): Promise<PullRowOutcome> => {
  const itemType = row.item_type
  if (!isSupportedRecordSyncItemType(itemType)) {
    return { kind: 'omit' }
  }
  // A shed tombstone (#2302) has no payload to read; its delete fact is the row.
  if (row.deleted_at && isMarkerRow(row)) {
    return {
      kind: 'purged_tombstone',
      entry: purgedTombstoneEntry({ ...row, item_type: itemType, deleted_at: row.deleted_at })
    }
  }

  let payload: EncryptedItemPayload
  try {
    payload = await readEncryptedPayload(storage, row.blob_key, userId, row.item_id)
  } catch (error) {
    // A missing object costs only this row, never the page (one dangling row
    // used to reject the whole Promise.all, so the client cursor never
    // advanced). A delete does not need its bytes: this covers the shed's crash
    // window between its R2 delete and its D1 mark, and a lost tombstone blob.
    if (error instanceof AppError && error.code === ErrorCodes.STORAGE_BLOB_NOT_FOUND) {
      return row.deleted_at
        ? {
            kind: 'purged_tombstone',
            entry: purgedTombstoneEntry({ ...row, item_type: itemType, deleted_at: row.deleted_at })
          }
        : { kind: 'blob_not_found' }
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

  return {
    kind: 'item',
    item: pullItemFromColumns(
      {
        id: row.item_id,
        type: itemType,
        operation: row.operation,
        cryptoVersion: row.crypto_version,
        signature: row.signature,
        signerDeviceId: row.signer_device_id,
        deletedAt: row.deleted_at,
        clock: row.clock
      },
      payload
    )
  }
}

// Upper bound on simultaneous R2 writes from one push batch.
//
// Subrequest arithmetic (paid plan: 1000 subrequests per invocation): a
// max-size push spends ≈100 R2 puts + ≈105 batched D1 statements (lookup ≤2,
// cursor range 2, upserts+shrinks ≤101... each statement in a db.batch counts)
// + device reads + the broadcast DO fetch ⇒ ~215 total, comfortably under the
// ceiling; the old serial code spent ~8 D1 round trips PER ITEM (~800) — this
// rewrite is what buys the headroom. Free plan (50) cannot fit any large push
// and could not before either. The window bounds simultaneous open writes so a
// full batch streams through in ~13 short waves instead of holding 100 R2
// connections at once.
const R2_PUSH_PUT_CONCURRENCY = 8

type PushItemOutcome = {
  accepted: boolean
  reason?: string
  serverCursor?: number
  /**
   * What a successful Stage 7 committed, kept as columns plus the R2 bytes so
   * nothing is parsed unless a socket item is actually built (#2300). Set only
   * when the batch asked for socket items.
   */
  committed?: { columns: PullItemColumns; payloadBytes: Uint8Array }
  committedAtMs?: number
}

/**
 * Upper bound on a socket item's serialized size beyond its R2 bytes: the
 * envelope keys plus the variable columns. Used to refuse an over-budget push
 * before building anything; the route still checks the exact size.
 */
const socketItemSizeEstimate = ({ columns, payloadBytes }: CommittedRow): number =>
  payloadBytes.byteLength +
  columns.id.length +
  columns.signature.length +
  columns.signerDeviceId.length +
  (columns.clock?.length ?? 0) +
  192

type CommittedRow = NonNullable<PushItemOutcome['committed']>

/**
 * The socket items of a push (#2300), or none. Decided from the sizes first,
 * so the kill switch and an over-budget push parse nothing. Runs after every
 * wave committed, outside Stage 7: a failure here can only drop the socket
 * items, never reject a committed row.
 */
const buildSocketItems = (rows: CommittedRow[], budget: number): RecordPullItemResponse[] => {
  if (budget <= 0 || rows.length === 0) return []
  let estimate = 0
  for (const row of rows) {
    estimate += socketItemSizeEstimate(row)
    if (estimate > budget) return []
  }
  try {
    return rows.map(({ columns, payloadBytes }) =>
      // The R2 object's exact text, parsed as the pull parses it.
      pullItemFromColumns(
        columns,
        JSON.parse(new TextDecoder().decode(payloadBytes)) as EncryptedItemPayload
      )
    )
  } catch (error) {
    logger.warn('Socket items dropped: a committed row did not rebuild', {
      error: error instanceof Error ? error.message : String(error)
    })
    return []
  }
}

const itemIdentity = (item: { type: string; id: string }): string => `${item.type}\u0000${item.id}`

/**
 * Splits a push batch into "waves" so the batched pipeline never processes two
 * pushes of the SAME (type, id) side by side: the old serial loop let a second
 * occurrence observe the row the first one wrote (version bump, replay check,
 * blob replacement). Occurrence N of an identity lands in wave N, and waves run
 * sequentially. Real batches have unique identities, so this is one wave.
 */
const splitIntoWaves = (
  items: PushItemInput[]
): Array<Array<{ item: PushItemInput; index: number }>> => {
  const occurrences = new Map<string, number>()
  const waves: Array<Array<{ item: PushItemInput; index: number }>> = []

  items.forEach((item, index) => {
    const key = itemIdentity(item)
    const wave = occurrences.get(key) ?? 0
    occurrences.set(key, wave + 1)
    ;(waves[wave] ??= []).push({ item, index })
  })

  return waves
}

interface PreparedPushItem {
  index: number
  item: PushItemInput
  existing: ExistingSyncItemRow | undefined
  payloadBytes: Uint8Array
  contentHash: string
  blobKey: string
  version: number
  sizeDelta: number
  reservedBytes: number
  /** #2408: the verified attestation this write stores, or null, which clears the column. */
  deleteAttestation: string | null
}

/**
 * The batched push pipeline for one wave of unique-identity items.
 *
 * Per-item error semantics are those of the old serial loop: every failure is
 * captured as that item's outcome (AppError code, or INTERNAL_ERROR for
 * anything untyped) and never aborts its neighbours — except the Stage 7
 * commit, which is all-or-nothing per wave (see its comment). What changed is
 * the I/O shape only — per-stage batching instead of per-item round trips:
 *
 *   1. shape + crypto-format validation            (CPU only)
 *   2. signature verification, one device fetch per unique signer
 *   3. existing-row lookup                         (one db.batch, 95-bind split)
 *   4. replay check + payload/hash derivation      (CPU only)
 *   5. storage reservation                         (one summed reserve; on
 *      failure, the old per-item reserve loop so quota outcomes match exactly)
 *   6. R2 puts with bounded concurrency
 *   7. cursor range + upserts + storage shrinks    (one transactional db.batch)
 *   8. replaced-blob cleanup                       (one bulk R2 delete, best-effort)
 */
const processPushWave = async (
  db: D1Database,
  storage: R2Bucket,
  userId: string,
  items: PushItemInput[],
  vaultId: string,
  client: ClientIdentity | null,
  collectCommitted = false
): Promise<PushItemOutcome[]> => {
  const outcomes: PushItemOutcome[] = new Array<PushItemOutcome>(items.length)
  const reject = (index: number, reason: string): void => {
    outcomes[index] = { accepted: false, reason }
  }
  const rejectWithError = (index: number, error: unknown): void => {
    reject(index, error instanceof AppError ? error.code : 'INTERNAL_ERROR')
  }
  const alive = (): number[] =>
    items.map((_, index) => index).filter((index) => outcomes[index] === undefined)

  // Stage 1: request-shape and crypto-format validation.
  items.forEach((item, index) => {
    if (
      !isSupportedRecordSyncItemType(item.type) ||
      (requiresRecordClock(item.type) && item.clock === undefined) ||
      item.stateVector !== undefined
    ) {
      reject(index, ErrorCodes.VALIDATION_ERROR)
      return
    }
    try {
      validateEncryptedFields(item)
    } catch (error) {
      rejectWithError(index, error)
    }
  })

  // Stage 2: signature verification. A batch is normally signed by ONE device,
  // so the device row is fetched once per unique signer instead of per item.
  const devices = new Map<string, Device | null>()
  try {
    for (const index of alive()) {
      const signerDeviceId = items[index].signerDeviceId
      if (!devices.has(signerDeviceId)) {
        devices.set(signerDeviceId, await getDevice(db, signerDeviceId, userId))
      }
    }
  } catch (error) {
    // The serial loop caught every failure per item, so a device-row read
    // outage surfaced as one INTERNAL_ERROR rejection per item, not as a
    // thrown 500. Keep that contract: reject every still-alive item and stop.
    for (const index of alive()) {
      rejectWithError(index, error)
    }
    return outcomes
  }
  const attestations = new Map<number, string>()
  await Promise.all(
    alive().map(async (index) => {
      try {
        const device = await verifySignatureWithDevice(
          devices.get(items[index].signerDeviceId) ?? null,
          items[index]
        )
        const attestation = await verifyDeleteAttestation(device, items[index])
        if (attestation) attestations.set(index, attestation)
      } catch (error) {
        rejectWithError(index, error)
      }
    })
  )

  // Stage 3: existing-row lookup, one db.batch. Ids are queried without the
  // type (a 100-item wave would need 200 bind params for (type, id) pairs) and
  // matched back on (type, id) here; a same-id row of another type is fetched
  // and ignored. Chunked at the D1 bind-param ceiling like pullItems.
  const existingByIdentity = new Map<string, ExistingSyncItemRow>()
  const lookupIndexes = alive()
  if (lookupIndexes.length > 0) {
    const ids = [...new Set(lookupIndexes.map((index) => items[index].id))]
    const perStatement = D1_MAX_BIND_PARAMS - 2
    const statements: D1PreparedStatement[] = []
    for (let i = 0; i < ids.length; i += perStatement) {
      const chunk = ids.slice(i, i + perStatement)
      statements.push(
        db
          .prepare(
            `SELECT item_type, item_id, version, clock, blob_key, size_bytes, created_at, deleted_at
             FROM sync_items
             WHERE user_id = ? AND vault_id = ? AND item_id IN (${chunk.map(() => '?').join(', ')})`
          )
          .bind(userId, vaultId, ...chunk)
      )
    }

    try {
      const results = await db.batch<ExistingSyncItemRow>(statements)
      for (const result of results) {
        for (const row of result.results ?? []) {
          existingByIdentity.set(itemIdentity({ type: row.item_type, id: row.item_id }), row)
        }
      }
    } catch (error) {
      for (const index of lookupIndexes) {
        rejectWithError(index, error)
      }
      return outcomes
    }
  }

  // Stage 4: replay checks and payload derivation.
  let prepared: PreparedPushItem[] = []
  for (const index of alive()) {
    const item = items[index]
    try {
      const existing = existingByIdentity.get(itemIdentity(item))
      if (existing && !isRecreateOverMarker(item, existing)) {
        const existingClock =
          typeof existing.clock === 'string'
            ? (JSON.parse(existing.clock) as VectorClock)
            : (existing.clock ?? undefined)
        if (shouldRejectRecordReplay(item.type, item.clock, existingClock)) {
          reject(index, ErrorCodes.SYNC_REPLAY_DETECTED)
          continue
        }
        if (
          shouldRejectResurrection(
            item.type,
            item.operation,
            existing.deleted_at,
            item.clock,
            existingClock
          )
        ) {
          reject(index, ErrorCodes.SYNC_DELETE_WINS)
          continue
        }
      }

      const payloadBytes = new TextEncoder().encode(serializePayload(item))
      const contentHash = await computeContentHash({
        dataNonce: item.dataNonce,
        encryptedData: item.encryptedData,
        encryptedKey: item.encryptedKey,
        keyNonce: item.keyNonce
      })
      const existingSize = existing ? (existing.size_bytes ?? 0) : 0

      prepared.push({
        index,
        item,
        existing,
        payloadBytes,
        contentHash,
        blobKey: generateItemBlobKey(userId, item.type, item.id, vaultId, contentHash),
        version: existing ? existing.version + 1 : 1,
        sizeDelta: payloadBytes.byteLength - existingSize,
        reservedBytes: 0,
        deleteAttestation: attestations.get(index) ?? null
      })
    } catch (error) {
      rejectWithError(index, error)
    }
  }

  // Stage 5: storage reservation. Fast path is ONE atomic reserve for the sum
  // of all growth. If it fails (quota, entitlement), fall back to the old
  // per-item reservation loop so each item gets exactly the accept/reject the
  // serial code gave it: items that fit are accepted in order, the ones that
  // do not are rejected with the reservation error.
  const totalGrowth = prepared.reduce((sum, entry) => sum + Math.max(0, entry.sizeDelta), 0)
  if (totalGrowth > 0) {
    try {
      await reserveStorage(db, userId, totalGrowth)
      for (const entry of prepared) {
        entry.reservedBytes = Math.max(0, entry.sizeDelta)
      }
    } catch {
      for (const entry of prepared) {
        if (entry.sizeDelta <= 0) continue
        try {
          await reserveStorage(db, userId, entry.sizeDelta)
          entry.reservedBytes = entry.sizeDelta
        } catch (error) {
          rejectWithError(entry.index, error)
        }
      }
      prepared = prepared.filter((entry) => outcomes[entry.index] === undefined)
    }
  }

  // Bytes reserved for items that fail beyond this point; refunded in one
  // adjustment at the end instead of one UPDATE per failed item.
  let refundBytes = 0

  // Stage 6: R2 puts, bounded concurrency.
  for (let i = 0; i < prepared.length; i += R2_PUSH_PUT_CONCURRENCY) {
    const window = prepared.slice(i, i + R2_PUSH_PUT_CONCURRENCY)
    await Promise.all(
      window.map(async (entry) => {
        try {
          await putBlob(storage, entry.blobKey, entry.payloadBytes.slice().buffer, userId)
        } catch (error) {
          refundBytes += entry.reservedBytes
          rejectWithError(entry.index, error)
        }
      })
    )
  }
  let stored = prepared.filter((entry) => outcomes[entry.index] === undefined)

  // Stage 7: cursor range, upserts and storage shrinks, one transactional
  // db.batch. The range is reserved inside the commit so cursor order equals
  // commit order (#2282). The batch lands whole or rejects every item in the
  // wave (a client retries rejected items either way), and a row never lands
  // without its shrink adjustment.
  if (stored.length > 0) {
    const now = Math.floor(Date.now() / 1000)
    const committedAtMs = Date.now()
    const cursors = reserveCursors(db, userId, stored.length)
    const statements: D1PreparedStatement[] = []
    const committedColumns: PullItemColumns[] = []
    for (const [position, entry] of stored.entries()) {
      const { item, existing } = entry
      const deletedAt = item.operation === 'delete' ? (item.deletedAt ?? now) : null
      const clock = item.clock ? JSON.stringify(item.clock) : null
      if (collectCommitted) {
        committedColumns.push({
          id: item.id,
          // Stage 1 rejected every type that is not a record type.
          type: item.type as RecordSyncItemType,
          operation: item.operation,
          cryptoVersion: CRYPTO_VERSION,
          signature: item.signature,
          signerDeviceId: item.signerDeviceId,
          deletedAt,
          clock
        })
      }
      statements.push(
        db
          .prepare(
            `INSERT INTO sync_items (
              id, user_id, vault_id, item_type, item_id, blob_key, size_bytes, content_hash,
              version, crypto_version, operation, server_cursor, signer_device_id, signature,
              state_vector, clock, created_at, updated_at, deleted_at,
              client_platform, client_version, committed_at_ms, delete_attestation
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${cursors.cursorSql}, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
              client_version = excluded.client_version,
              committed_at_ms = excluded.committed_at_ms,
              -- #2408: describes this write only. A non-attested write clears it,
              -- so a stale attestation never outlives the delete it signed.
              delete_attestation = excluded.delete_attestation,
              -- An accepted push is a new version with fresh bytes (#2302).
              payload_purged_at = NULL,
              blob_missing_at = NULL`
          )
          .bind(
            crypto.randomUUID(),
            userId,
            vaultId,
            item.type,
            item.id,
            entry.blobKey,
            entry.payloadBytes.byteLength,
            entry.contentHash,
            entry.version,
            CRYPTO_VERSION,
            item.operation,
            ...cursors.cursorBinds(position),
            item.signerDeviceId,
            item.signature,
            item.stateVector ?? null,
            clock,
            existing?.created_at ?? existing?.createdAt ?? now,
            now,
            deletedAt,
            client?.platform ?? null,
            client?.version ?? null,
            committedAtMs,
            entry.deleteAttestation
          )
      )
      if (entry.sizeDelta < 0) {
        statements.push(
          db
            .prepare('UPDATE users SET storage_used = MAX(0, storage_used + ?) WHERE id = ?')
            .bind(entry.sizeDelta, userId)
        )
      }
    }

    try {
      const results = await db.batch(cursors.batch(statements))
      for (const [position, entry] of stored.entries()) {
        outcomes[entry.index] = {
          accepted: true,
          serverCursor: cursors.cursorAt(results, position),
          ...(collectCommitted
            ? {
                committed: {
                  columns: committedColumns[position],
                  payloadBytes: entry.payloadBytes
                }
              }
            : {}),
          committedAtMs
        }
      }
    } catch (error) {
      for (const entry of stored) {
        refundBytes += entry.reservedBytes
        rejectWithError(entry.index, error)
      }
      stored = []
    }
  }

  // Stage 8: replaced-blob cleanup. The rows now point at the new
  // content-addressed objects, so every previous version's blob is unreachable
  // through any row and can go — in ONE bulk delete. Best-effort: a failed
  // delete leaks bounded orphan objects, never a dangling row. An in-flight
  // pull that read an old row before the upsert may 404 on the old key; the
  // pull path tolerates that per item, and the replacement row re-arrives at a
  // later cursor.
  const replacedBlobKeys = stored
    .filter((entry) => entry.existing?.blob_key && entry.existing.blob_key !== entry.blobKey)
    .map((entry) => entry.existing?.blob_key as string)
  if (replacedBlobKeys.length > 0) {
    try {
      await deleteBlobs(storage, replacedBlobKeys, userId)
    } catch {
      // Orphans are invisible to readers; acceptable until a sweep job exists.
    }
  }

  // The refund must never surface as an item outcome: the items it covers are
  // already rejected for their real reason (crdt.ts documents the same rule).
  if (refundBytes > 0) {
    try {
      await adjustStorageUsed(db, userId, -refundBytes)
    } catch (refundError) {
      logger.error('storage refund failed', {
        operation: 'processPushWave',
        vaultId,
        refundBytes,
        error: refundError instanceof Error ? refundError.message : String(refundError)
      })
    }
  }

  return outcomes
}

export const processRecordPushBatch = async (
  db: D1Database,
  storage: R2Bucket,
  userId: string,
  deviceId: string,
  items: PushItemInput[],
  vaultId = 'default',
  client: ClientIdentity | null = null,
  /** Byte budget for socket items (#2300); 0 builds none. */
  socketItemsBudget = 0
): Promise<RecordPushBatchResult> => {
  const itemOutcomes = new Array<PushItemOutcome>(items.length)
  for (const wave of splitIntoWaves(items)) {
    const waveOutcomes = await processPushWave(
      db,
      storage,
      userId,
      wave.map((entry) => entry.item),
      vaultId,
      client,
      socketItemsBudget > 0
    )
    wave.forEach((entry, position) => {
      itemOutcomes[entry.index] = waveOutcomes[position]
    })
  }

  const accepted: string[] = []
  const rejected: Array<{ id: string; reason: string }> = []
  const outcomes: RecordPushBatchOutcome[] = []
  const committed: Array<{ serverCursor: number; row: CommittedRow }> = []
  let maxCursor = 0
  let committedAtMs = 0

  items.forEach((item, index) => {
    const result = itemOutcomes[index]
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
      if (result.committed && result.serverCursor !== undefined) {
        committed.push({ serverCursor: result.serverCursor, row: result.committed })
      }
      if (result.committedAtMs && result.committedAtMs > committedAtMs) {
        committedAtMs = result.committedAtMs
      }
      return
    }

    rejected.push({ id: item.id, reason: result.reason ?? 'UNKNOWN' })
  })

  return {
    accepted,
    rejected,
    serverTime: Math.floor(Date.now() / 1000),
    maxCursor,
    outcomes,
    committedItems: buildSocketItems(
      committed.sort((a, b) => a.serverCursor - b.serverCursor).map((entry) => entry.row),
      socketItemsBudget
    ),
    committedAtMs
  }
}

export const processPushItem = async (
  db: D1Database,
  storage: R2Bucket,
  userId: string,
  _deviceId: string,
  item: PushItemInput,
  vaultId = 'default',
  client: ClientIdentity | null = null
): Promise<PushItemOutcome> => {
  const [outcome] = await processPushWave(db, storage, userId, [item], vaultId, client)
  return outcome
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

/** Opt-in manifest pagination window. Absent = the original everything-at-once response. */
export interface ManifestPage {
  /** Return rows with server_cursor strictly greater than this. 0 starts from the beginning. */
  cursor: number
  /** Page size; capped at MAX_MANIFEST_PAGE_LIMIT. */
  limit: number
}

export const getManifest = async (
  db: D1Database,
  userId: string,
  vaultId = 'default',
  types: readonly RecordSyncItemType[] = LEGACY_RECORD_SYNC_ITEM_TYPES,
  page?: ManifestPage
): Promise<RecordSyncManifest> => {
  if (types.length === 0) {
    return { items: [], serverTime: Math.floor(Date.now() / 1000) }
  }

  // Pagination keys on server_cursor: it is unique per user and only ever
  // grows, so pages can neither skip nor split rows. A row updated BETWEEN
  // pages gets a new cursor greater than any page already served — it may
  // appear twice across the run (once at its old cursor, again at its new one),
  // never zero times; the client's (type, id) map dedups the repeat. Old
  // clients pass no page and get the complete single response they always did.
  const effectiveLimit = page ? Math.min(page.limit, MAX_MANIFEST_PAGE_LIMIT) : null

  const rows = await db
    .prepare(
      `SELECT item_id, item_type, version, updated_at, size_bytes, state_vector, server_cursor
       FROM sync_items
       WHERE user_id = ? AND vault_id = ? AND deleted_at IS NULL AND item_type IN (${placeholdersFor(types)})
       ${page ? 'AND server_cursor > ?' : ''}
       ORDER BY server_cursor ASC
       ${effectiveLimit !== null ? 'LIMIT ?' : ''}`
    )
    .bind(
      userId,
      vaultId,
      ...types,
      // +1 row probes for another page without a COUNT query.
      ...(page && effectiveLimit !== null ? [page.cursor, effectiveLimit + 1] : [])
    )
    .all<{
      item_id: string
      item_type: string
      version: number
      updated_at: number
      size_bytes: number
      state_vector: string | null
      server_cursor: number
    }>()

  const allRows = rows.results ?? []
  const hasMore = effectiveLimit !== null && allRows.length > effectiveLimit
  const pageRows = hasMore ? allRows.slice(0, effectiveLimit) : allRows

  const items = pageRows
    .filter((row) => isSupportedRecordSyncItemType(row.item_type))
    .map((row) => ({
      id: row.item_id,
      type: row.item_type as RecordSyncItemType,
      version: row.version,
      modifiedAt: row.updated_at,
      size: row.size_bytes
    }))

  // nextCursor comes from the last row KEPT, unsupported types included — the
  // filter above must not create a gap the next page would then skip over.
  const lastRow = pageRows[pageRows.length - 1]

  return {
    items,
    serverTime: Math.floor(Date.now() / 1000),
    ...(hasMore && lastRow ? { nextCursor: lastRow.server_cursor } : {})
  }
}

/** One `sync_items` row as the changes feed reads it: the ref columns plus the pull columns. */
type ChangesRow = StoredSyncItemPullRow & {
  version: number
  updated_at: number
  size_bytes: number
  committed_at_ms: number | null
}

/** Rows per `?inline=1` page: ≤ 100 × 64 KiB of stored JSON, about 6.5 MB per response. */
const MAX_INLINE_CHANGES_LIMIT = 100
/** A row is inlined only when its stored R2 object (`size_bytes`) is at most this. */
const INLINE_MAX_BLOB_BYTES = 64 * 1024

/**
 * Rows `?inline=1` may inline. Coverage is by id because `/sync/pull` ids are
 * untyped (protocol 05 §5.11.2): an id qualifies only when every page row with
 * that id is small enough, so no un-inlined sibling of another type is
 * stranded behind an id the reader treats as delivered.
 */
const selectInlineRows = (rows: ChangesRow[]): ChangesRow[] => {
  const oversized = new Set(
    rows.filter((row) => row.size_bytes > INLINE_MAX_BLOB_BYTES).map((row) => row.item_id)
  )
  return rows.filter((row) => !oversized.has(row.item_id))
}

const mapInWindows = async <T, R>(
  items: readonly T[],
  width: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> => {
  const out: R[] = []
  for (let i = 0; i < items.length; i += width) {
    out.push(...(await Promise.all(items.slice(i, i + width).map(fn))))
  }
  return out
}

/**
 * Inlining never fails a page. A row that reads as null (missing blob,
 * unsupported type) or throws (missing signer metadata, corrupt clock or blob)
 * takes every other row of its id out of `inline` too, so the reader fetches
 * that id through `/sync/pull`, which answers exactly as it does today.
 */
const readInlineItems = async (
  storage: R2Bucket,
  userId: string,
  rows: ChangesRow[]
): Promise<RecordPullItemResponse[]> => {
  const eligible = selectInlineRows(rows)
  const read = await mapInWindows(eligible, R2_CONCURRENCY, (row) =>
    readPullRow(storage, userId, row)
      .then((outcome) => (outcome.kind === 'item' ? outcome.item : null))
      .catch((error: unknown) => {
        // Code and type only: an item id can be a tag name or a folder path.
        logger.warn('Inline changes: row left to /sync/pull', {
          itemType: row.item_type,
          code: error instanceof AppError ? error.code : 'unknown'
        })
        return null
      })
  )
  const failedIds = new Set(eligible.filter((_, i) => read[i] === null).map((row) => row.item_id))
  return read.filter(
    (item): item is RecordPullItemResponse => item !== null && !failedIds.has(item.id)
  )
}

/** A /sync/changes page as the server builds it. The wire schema types `noteBodies` as unknown[]. */
export type ChangesPage = Omit<RecordChangesResponse, 'noteBodies'> & {
  noteBodies?: NoteBodyChange[]
}

/** A served sync_items row keeps its pull columns so `?inline=1` can inline it. */
type RecordChangeValue =
  | { kind: 'ref'; ref: RecordChangesResponse['items'][number]; row: ChangesRow }
  | { kind: 'tombstone'; id: string; row: ChangesRow }

/** The sync_items half of a /sync/changes page: ref columns plus pull columns. */
const recordFeedSource =
  (
    db: D1Database,
    userId: string,
    vaultId: string,
    types: readonly RecordSyncItemType[],
    includeMarkers: boolean
  ): FeedSourceBuilder<RecordChangeValue> =>
  (after, fetchLimit) => ({
    statement: db
      .prepare(
        `SELECT id, item_id, item_type, version, updated_at, size_bytes, state_vector, server_cursor, deleted_at,
              committed_at_ms, blob_key, crypto_version, operation, signer_device_id, signature, clock
       FROM sync_items
       WHERE user_id = ? AND vault_id = ? AND server_cursor > ? AND item_type IN (${placeholdersFor(types)})
         ${includeMarkers ? '' : `AND ${NOT_A_MARKER_SQL}`}
       ORDER BY server_cursor ASC
       LIMIT ?`
      )
      .bind(userId, vaultId, after, ...types, fetchLimit),
    parse: (rows) =>
      (rows as ChangesRow[]).map((row) => {
        if (!isSupportedRecordSyncItemType(row.item_type)) {
          return { cursor: row.server_cursor, value: null }
        }
        if (row.deleted_at) {
          return { cursor: row.server_cursor, value: { kind: 'tombstone', id: row.item_id, row } }
        }
        return {
          cursor: row.server_cursor,
          value: {
            kind: 'ref',
            row,
            ref: {
              id: row.item_id,
              type: row.item_type,
              version: row.version,
              modifiedAt: row.updated_at,
              size: row.size_bytes,
              serverCursor: row.server_cursor,
              ...(typeof row.committed_at_ms === 'number'
                ? { committedAtMs: row.committed_at_ms }
                : {})
            }
          }
        }
      })
  })

/**
 * GET /sync/changes. One path for every mode:
 * - records only (the legacy response, byte for byte);
 * - `note_body` declared (#2295): body rows from both CRDT tables merged into
 *   the same page, read in one db.batch;
 * - `inlineFrom` given (`?inline=1`, #2292): the `/sync/pull` items of the
 *   record rows this page serves, read after the page is closed so `inline`
 *   never names a row beyond `nextCursor`.
 * A page that carries bodies or inline payloads is clamped to 100 rows.
 */
export const getChanges = async (
  db: D1Database,
  userId: string,
  cursor: number,
  limit?: number,
  vaultId = 'default',
  subscription: SyncSubscription = LEGACY_SYNC_SUBSCRIPTION,
  inlineFrom?: R2Bucket
): Promise<ChangesPage> => {
  const { recordTypes, noteBodies } = subscription
  if (recordTypes.length === 0 && !noteBodies) {
    return {
      items: [],
      deleted: [],
      hasMore: false,
      nextCursor: cursor,
      ...(inlineFrom ? { inline: [] } : {})
    }
  }

  const effectiveLimit = Math.min(
    limit ?? DEFAULT_CHANGES_LIMIT,
    inlineFrom
      ? MAX_INLINE_CHANGES_LIMIT
      : noteBodies
        ? MAX_NOTE_BODY_CHANGES_LIMIT
        : MAX_CHANGES_LIMIT
  )
  const sources: Array<FeedSourceBuilder<RecordChangeValue | NoteBodyChange>> = []
  // A marker (#2302) is listed only to a client that declared it applies them,
  // and never from cursor 0: a fresh or reset device gains nothing from it and
  // must not delete rows it restored locally.
  const includeMarkers = subscription.purgedTombstones === true && cursor > 0
  if (recordTypes.length > 0) {
    sources.push(recordFeedSource(db, userId, vaultId, recordTypes, includeMarkers))
  }
  if (noteBodies) sources.push(noteBodyFeedSource(db, userId, vaultId))

  const page = await readChangePage(db, sources, cursor, effectiveLimit)

  const items: RecordChangesResponse['items'] = []
  const deleted: string[] = []
  const bodies: NoteBodyChange[] = []
  const servedRows: ChangesRow[] = []
  for (const entry of page.entries) {
    if ('op' in entry) {
      bodies.push(entry)
      continue
    }
    servedRows.push(entry.row)
    if (entry.kind === 'tombstone') deleted.push(entry.id)
    else items.push(entry.ref)
  }

  return {
    items,
    deleted,
    hasMore: page.hasMore,
    nextCursor: page.nextCursor,
    ...(noteBodies ? { noteBodies: bodies } : {}),
    ...(inlineFrom ? { inline: await readInlineItems(inlineFrom, userId, servedRows) } : {})
  }
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

// Upper bound on simultaneous R2 reads from pullItems. Conservative for a
// Worker (avoids firing hundreds of subrequests at once); tune here if needed.
const R2_CONCURRENCY = 25

/**
 * Records that a live row's R2 object is gone (#2302). Conditional on
 * `blob_key`, so a row replaced since it was read is never marked, and on
 * `deleted_at IS NULL`, so a tombstone is never marked. Report only: nothing
 * deletes a row because of this mark. Returns true when the row was marked.
 */
const markSyncItemBlobMissing = async (
  db: D1Database,
  rowId: string,
  blobKey: string,
  now: number
): Promise<boolean> => {
  const result = await db
    .prepare(
      `UPDATE sync_items SET blob_missing_at = COALESCE(blob_missing_at, ?)
       WHERE id = ? AND blob_key = ? AND deleted_at IS NULL`
    )
    .bind(now, rowId, blobKey)
    .run()
  return (result.meta.changes ?? 0) > 0
}

/** A POST /sync/pull answer: signed items plus the #2302 sibling entries. */
export interface RecordPullResult {
  items: RecordPullItemResponse[]
  purgedTombstones: RecordPullPurgedTombstone[]
  blobMissing: RecordPullBlobMissing[]
}

export const pullItems = async (
  db: D1Database,
  storage: R2Bucket,
  userId: string,
  itemIds: string[],
  vaultId = 'default',
  types: readonly RecordSyncItemType[] = LEGACY_RECORD_SYNC_ITEM_TYPES,
  /** The client declared `purged_tombstones` (#2302). Otherwise a marker is left out, as a purged row was. */
  servePurgedTombstones = false
): Promise<RecordPullResult> => {
  const result: RecordPullResult = { items: [], purgedTombstones: [], blobMissing: [] }
  if (itemIds.length === 0 || types.length === 0) {
    return result
  }

  // 95 D1 bind params, minus user_id + vault_id, minus one per negotiated type.
  const BATCH_SIZE = D1_MAX_BIND_PARAMS - 2 - types.length

  const allDbRows: StoredSyncItemPullRow[] = []

  for (let i = 0; i < itemIds.length; i += BATCH_SIZE) {
    const batch = itemIds.slice(i, i + BATCH_SIZE)
    const placeholders = batch.map(() => '?').join(', ')
    const rows = await db
      .prepare(
        `SELECT id, item_id, item_type, blob_key, crypto_version, operation, signer_device_id, signature,
                state_vector, clock, deleted_at, server_cursor, delete_attestation
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
  const outcomes = await mapInWindows(allDbRows, R2_CONCURRENCY, (row) =>
    readPullRow(storage, userId, row)
  )

  const notFound: StoredSyncItemPullRow[] = []
  outcomes.forEach((outcome, index) => {
    if (outcome.kind === 'item') result.items.push(outcome.item)
    else if (outcome.kind === 'purged_tombstone' && servePurgedTombstones) {
      result.purgedTombstones.push(outcome.entry)
    } else if (outcome.kind === 'blob_not_found') notFound.push(allDbRows[index])
  })

  // A 404 on a live row is a lost blob only while the row still points at that
  // object. A row replaced since it was read (push Stage 8 deletes the old key)
  // is left out, as before: the replacement re-arrives at a later cursor.
  const now = Math.floor(Date.now() / 1000)
  const lost = await mapInWindows(notFound, R2_CONCURRENCY, (row) =>
    markSyncItemBlobMissing(db, row.id, row.blob_key, now).catch((error: unknown) => {
      logger.error('Marking a lost blob failed; row left out of the pull', {
        itemType: row.item_type,
        error: error instanceof Error ? error.message : String(error)
      })
      return false
    })
  )
  notFound.forEach((row, index) => {
    if (!lost[index]) return
    result.blobMissing.push({
      id: row.item_id,
      type: row.item_type as RecordSyncItemType,
      serverCursor: row.server_cursor
    })
  })

  return result
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

export {
  DEFAULT_CHANGES_LIMIT,
  MAX_CHANGES_LIMIT,
  MAX_ENCRYPTED_DATA_BYTES,
  MAX_MANIFEST_PAGE_LIMIT
}
