import type { Context } from 'hono'
import { Hono } from 'hono'
import { z } from 'zod'

import { PullRequestSchema, RecordPushRequestSchema } from '@memry/contracts/sync-api'
import { safeBase64Decode } from '../lib/encoding'
import { AppError, ErrorCodes } from '../lib/errors'
import { authMiddleware } from '../middleware/auth'
import { clientGateMiddleware } from '../middleware/client-gate'
import { getClientPolicy, toPolicySnapshot } from '../services/client-policies'
import { paidSyncMiddleware } from '../middleware/paid-sync'
import { createRateLimiter, deviceIdentifier } from '../middleware/rate-limit'
import { syncTypesMiddleware } from '../middleware/sync-types'
import {
  getChanges,
  getItem,
  getManifest,
  getSyncStatus,
  listUserVaults,
  processRecordPushBatch,
  pullItems,
  setVaultName,
  updateDeviceCursor,
  type ManifestPage
} from '../services/sync'
import {
  ensureSyncVaultAllowed,
  getSyncEntitlement,
  isPaidSyncEntitlementActive
} from '../services/entitlements'
import { deleteVaultData, vaultExistsForUser } from '../services/vault-deletion'
import {
  logCrdtTraffic,
  logRecordPushBatch,
  logRecordQueryBatch,
  logSyncValidationFailure
} from '../services/sync-telemetry'
import { captureBusinessEvent, safeWaitUntil, waitUntilCaptured } from '../services/analytics'
import { updateDevice } from '../services/device'
import { getStorageBreakdown } from '../services/storage'
import {
  storeUpdates,
  getUpdates,
  getBatchUpdates,
  storeSnapshot,
  getSnapshot,
  pruneUpdatesBeforeSnapshot
} from '../services/crdt'
import { enqueuePackCompaction } from '../services/pack-compaction'
import { listPacks } from '../services/pack-list'
import { resolveR2PresignConfig } from '../services/r2-presign'
import type { AppContext } from '../types'

export const sync = new Hono<AppContext>()

sync.use('*', authMiddleware)
sync.use('*', clientGateMiddleware)

// Auth-only, NOT single-vault-gated: a joining device must enumerate every vault
// on the account, so this route is registered before paidSyncMiddleware (which
// runs ensureSyncVaultAllowed against a single X-Memry-Vault-Id). Hono applies
// `use('*')` only to routes registered after it.
const vaultsRateLimit = createRateLimiter({
  keyPrefix: 'sync_vaults',
  maxRequests: 60,
  windowSeconds: 60
})

const handleListVaults = async (c: Context<AppContext>): Promise<Response> => {
  const userId = c.get('userId')!
  const vaults = await listUserVaults(c.env.DB, userId)
  return c.json({ vaults })
}

sync.get('/vaults', vaultsRateLimit, handleListVaults)

const RegisterVaultSchema = z.object({
  vaultUuid: z.string().min(1).max(128),
  encryptedName: z.string().min(1).max(2048),
  nameNonce: z.string().min(1).max(128)
})

// Auth-only like GET /vaults: registration must work for a vault that has never
// pushed (paidSyncMiddleware gates on the X-Memry-Vault-Id header, which a brand
// new vault cannot satisfy yet). Paid access is enforced inline instead.
const handleRegisterVault = async (c: Context<AppContext>): Promise<Response> => {
  const userId = c.get('userId')!
  const parsed = RegisterVaultSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) {
    return c.json({ error: 'Invalid vault registration payload' }, 400)
  }

  const entitlement = await getSyncEntitlement(c.env.DB, userId)
  if (!isPaidSyncEntitlementActive(entitlement)) {
    return c.json({ error: 'Active sync subscription required' }, 402)
  }

  await ensureSyncVaultAllowed(c.env.DB, userId, parsed.data.vaultUuid, entitlement)
  await setVaultName(
    c.env.DB,
    userId,
    parsed.data.vaultUuid,
    parsed.data.encryptedName,
    parsed.data.nameNonce
  )

  safeWaitUntil(c, captureBusinessEvent(c.env, 'vault_registered', userId, {}))

  return c.json({ success: true })
}

sync.post('/vaults', vaultsRateLimit, handleRegisterVault)

// Auth-only like GET/POST /vaults, and registered before paidSyncMiddleware for
// a sharper reason: that middleware runs ensureSyncVaultAllowed, which UPSERTS.
// Below it, this route would have its own target re-created mid-request.
const handleDeleteVault = async (c: Context<AppContext>): Promise<Response> => {
  const userId = c.get('userId')!
  const vaultId = c.req.param('vaultId')

  if (!vaultId || !/^[a-zA-Z0-9_-]{1,128}$/.test(vaultId)) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Invalid vault id', 400)
  }

  if (!(await vaultExistsForUser(c.env.DB, userId, vaultId))) {
    throw new AppError(ErrorCodes.SYNC_VAULT_NOT_FOUND, 'Vault not found', 404)
  }

  await deleteVaultData(c.env.DB, c.env.STORAGE, userId, vaultId)

  safeWaitUntil(c, captureBusinessEvent(c.env, 'vault_deleted', userId, {}))

  return c.json({ success: true })
}

sync.delete('/vaults/:vaultId', vaultsRateLimit, handleDeleteVault)

sync.use('*', paidSyncMiddleware)
sync.use('*', syncTypesMiddleware)

const MAX_UPDATE_BYTES = 5 * 1024 * 1024 // 5MB per individual update
const BASE64_CHUNK_SIZE = 8192

const getRequestPath = (c: Context<AppContext>): string => new URL(c.req.url).pathname

function parseTransportRequest<T>(
  schema: z.ZodType<T>,
  body: unknown,
  params: {
    transport: 'record' | 'crdt'
    endpoint: string
    label: string
  }
): T {
  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]?.message ?? 'validation failed'
    logSyncValidationFailure({
      transport: params.transport,
      endpoint: params.endpoint,
      issue
    })
    throw new AppError(ErrorCodes.VALIDATION_ERROR, `Invalid ${params.label}: ${issue}`, 400)
  }

  return parsed.data
}

function logQueryValidationFailure(
  transport: 'record' | 'crdt',
  endpoint: string,
  issue: string,
  code: keyof typeof ErrorCodes = 'VALIDATION_ERROR'
): never {
  logSyncValidationFailure({ transport, endpoint, issue })
  throw new AppError(ErrorCodes[code], issue, 400)
}

function safeBase64Encode(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let result = ''
  for (let i = 0; i < bytes.length; i += BASE64_CHUNK_SIZE) {
    const chunk = bytes.subarray(i, i + BASE64_CHUNK_SIZE)
    result += String.fromCharCode(...chunk)
  }
  return btoa(result)
}

function decodeCrdtPayload(base64: string, endpoint: string, tooLargeMessage: string): ArrayBuffer {
  try {
    const bytes = safeBase64Decode(base64)
    if (bytes.byteLength > MAX_UPDATE_BYTES) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, tooLargeMessage, 413)
    }
    return bytes.slice().buffer as ArrayBuffer
  } catch (error) {
    if (error instanceof AppError) {
      logSyncValidationFailure({
        transport: 'crdt',
        endpoint,
        issue: error.message
      })
    }
    throw error
  }
}

const pushRateLimit = createRateLimiter({
  keyPrefix: 'sync_push',
  maxRequests: 60,
  windowSeconds: 60
})

const changesRateLimit = createRateLimiter({
  keyPrefix: 'sync_changes',
  maxRequests: 60,
  windowSeconds: 60
})

const pullRateLimit = createRateLimiter({
  keyPrefix: 'sync_pull',
  maxRequests: 120,
  windowSeconds: 60
})

// 30/min (was 10): a paginated client spends ceil(rows / page) requests per
// integrity check instead of 1, so the old ceiling would have stalled any vault
// past 10 pages. Each paged request is a bounded indexed scan — strictly
// cheaper than the single unbounded full scan the old ceiling was budgeted for.
const manifestRateLimit = createRateLimiter({
  keyPrefix: 'sync_manifest',
  maxRequests: 30,
  windowSeconds: 60
})

const statusRateLimit = createRateLimiter({
  keyPrefix: 'sync_status',
  maxRequests: 60,
  windowSeconds: 60
})

const wsRateLimit = createRateLimiter({
  keyPrefix: 'sync_ws',
  maxRequests: 15,
  windowSeconds: 60
})

sync.get('/ws', wsRateLimit, async (c) => {
  if (c.req.header('Upgrade') !== 'websocket') {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Expected WebSocket upgrade', 426)
  }
  const userId = c.get('userId')!
  const vaultId = c.get('vaultId')!
  const id = c.env.USER_SYNC_STATE.idFromName(userId)
  const stub = c.env.USER_SYNC_STATE.get(id)
  const headers = new Headers(c.req.raw.headers)
  headers.set('X-Memry-Vault-Id', vaultId)
  return stub.fetch(
    new Request(new URL('/connect', c.req.url), {
      headers
    })
  )
})

const storageRateLimit = createRateLimiter({
  keyPrefix: 'sync_storage',
  maxRequests: 30,
  windowSeconds: 60
})

sync.get('/storage', storageRateLimit, async (c) => {
  const userId = c.get('userId')!
  const breakdown = await getStorageBreakdown(c.env.DB, userId)
  return c.json(breakdown)
})

const handleRecordStatus = async (c: Context<AppContext>): Promise<Response> => {
  const userId = c.get('userId')!
  const deviceId = c.get('deviceId')!
  const vaultId = c.get('vaultId')!
  const status = await getSyncStatus(c.env.DB, userId, deviceId, vaultId)

  // Status is what a client polls on startup and on foreground, so it is where
  // a flipped kill switch reaches a device WITHOUT the device first attempting
  // a write and eating a 403 (contract §2, last bullet). Only clients that
  // identified themselves get the field: a header-less desktop build receives
  // byte-for-byte the response it received before this shipped, and pays no
  // extra query for it.
  const client = c.get('client')
  if (!client) return c.json(status)

  const policy = await getClientPolicy(c.env.DB, client.platform)
  return c.json({ ...status, clientPolicy: toPolicySnapshot(client.platform, policy) })
}

const handleRecordManifest = async (c: Context<AppContext>): Promise<Response> => {
  const userId = c.get('userId')!
  const vaultId = c.get('vaultId')!
  const endpoint = getRequestPath(c)

  // Pagination is OPT-IN via `limit` (+ optional `cursor`). A param-less
  // request — every already-shipped client — keeps the original complete
  // single-response behavior, nextCursor field and all absent.
  const limitParam = c.req.query('limit')
  const cursorParam = c.req.query('cursor')

  let page: ManifestPage | undefined
  if (limitParam !== undefined) {
    const limit = parseInt(limitParam, 10)
    if (isNaN(limit) || limit < 1) {
      logQueryValidationFailure('record', endpoint, 'Invalid limit value')
    }
    const cursor = cursorParam ? parseInt(cursorParam, 10) : 0
    if (isNaN(cursor) || cursor < 0) {
      logQueryValidationFailure('record', endpoint, 'Invalid cursor value', 'SYNC_INVALID_CURSOR')
    }
    page = { cursor, limit }
  } else if (cursorParam !== undefined) {
    // A cursor without a limit is a malformed pagination attempt; answering it
    // with the full manifest would silently duplicate the pages already served.
    logQueryValidationFailure('record', endpoint, 'cursor requires limit')
  }

  const manifest = await getManifest(c.env.DB, userId, vaultId, c.get('syncTypes')!, page)
  return c.json(manifest)
}

const handleRecordChanges = async (c: Context<AppContext>): Promise<Response> => {
  const userId = c.get('userId')!
  const deviceId = c.get('deviceId')!
  const vaultId = c.get('vaultId')!
  const endpoint = getRequestPath(c)
  const startedAt = Date.now()

  const cursorParam = c.req.query('cursor')
  const limitParam = c.req.query('limit')

  const cursor = cursorParam ? parseInt(cursorParam, 10) : 0
  if (isNaN(cursor) || cursor < 0) {
    logQueryValidationFailure('record', endpoint, 'Invalid cursor value', 'SYNC_INVALID_CURSOR')
  }

  const limit = limitParam ? parseInt(limitParam, 10) : undefined
  if (limit !== undefined && (isNaN(limit) || limit < 1)) {
    logQueryValidationFailure('record', endpoint, 'Invalid limit value')
  }

  const changes = await getChanges(c.env.DB, userId, cursor, limit, vaultId, c.get('syncTypes')!)

  if (changes.items.length > 0 || changes.deleted.length > 0) {
    await updateDeviceCursor(c.env.DB, deviceId, userId, changes.nextCursor, vaultId)
    await updateDevice(c.env.DB, deviceId, userId, {
      last_sync_at: Math.floor(Date.now() / 1000)
    })
  }

  logRecordQueryBatch({
    endpoint,
    operation: 'changes',
    latencyMs: Date.now() - startedAt,
    itemTypes: changes.items.map((item) => item.type),
    deletedCount: changes.deleted.length
  })

  return c.json(changes)
}

const handleRecordPush = async (c: Context<AppContext>): Promise<Response> => {
  const userId = c.get('userId')!
  const deviceId = c.get('deviceId')!
  const vaultId = c.get('vaultId')!
  const endpoint = getRequestPath(c)
  const startedAt = Date.now()

  const body: unknown = await c.req.json()
  const parsed = parseTransportRequest(RecordPushRequestSchema, body, {
    transport: 'record',
    endpoint,
    label: 'push request'
  })

  let result
  try {
    result = await processRecordPushBatch(
      c.env.DB,
      c.env.STORAGE,
      userId,
      deviceId,
      parsed.items,
      vaultId,
      c.get('client') ?? null
    )
  } catch (error) {
    if (error instanceof AppError && error.code === ErrorCodes.STORAGE_QUOTA_EXCEEDED) {
      logRecordPushBatch({
        endpoint,
        latencyMs: Date.now() - startedAt,
        outcomes: parsed.items.map((item) => ({
          id: item.id,
          type: item.type,
          accepted: false,
          reason: error.code
        }))
      })
    }
    throw error
  }

  if (result.maxCursor > 0) {
    await updateDeviceCursor(c.env.DB, deviceId, userId, result.maxCursor, vaultId)
  }

  if (result.accepted.length > 0) {
    await updateDevice(c.env.DB, deviceId, userId, {
      last_sync_at: Math.floor(Date.now() / 1000)
    })
    // Pack compaction nudge (#1839): AFTER the commit above (a failed enqueue
    // must never fail an already-committed push). Best-effort via waitUntil —
    // at-least-once delivery + idempotent core make duplicates harmless, and
    // a lost message only delays packing until the next nudge or backfill.
    waitUntilCaptured(
      c,
      enqueuePackCompaction(c.env, { userId, vaultId }),
      { source: 'PackQueue', action: 'pack_enqueue_failed' }
    )
    const doId = c.env.USER_SYNC_STATE.idFromName(userId)
    const stub = c.env.USER_SYNC_STATE.get(doId)
    waitUntilCaptured(
      c,
      stub.fetch(
        new Request(new URL('/broadcast', c.req.url), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ excludeDeviceId: deviceId, cursor: result.maxCursor, vaultId })
        })
      ),
      { source: 'UserSyncState', action: 'record_push_broadcast_failed' }
    )
  }

  logRecordPushBatch({
    endpoint,
    latencyMs: Date.now() - startedAt,
    outcomes: result.outcomes
  })

  return c.json({
    accepted: result.accepted,
    rejected: result.rejected,
    serverTime: result.serverTime,
    maxCursor: result.maxCursor
  })
}

const handleRecordPull = async (c: Context<AppContext>): Promise<Response> => {
  const userId = c.get('userId')!
  const vaultId = c.get('vaultId')!
  const endpoint = getRequestPath(c)
  const startedAt = Date.now()

  const body: unknown = await c.req.json()
  const parsed = parseTransportRequest(PullRequestSchema, body, {
    transport: 'record',
    endpoint,
    label: 'pull request'
  })

  const items = await pullItems(
    c.env.DB,
    c.env.STORAGE,
    userId,
    parsed.itemIds,
    vaultId,
    c.get('syncTypes')!
  )
  logRecordQueryBatch({
    endpoint,
    operation: 'pull',
    latencyMs: Date.now() - startedAt,
    itemTypes: items.map((item) => item.type)
  })

  return c.json({ items })
}

const handleRecordItem = async (c: Context<AppContext>): Promise<Response> => {
  const userId = c.get('userId')!
  const vaultId = c.get('vaultId')!
  const itemId = c.req.param('id')

  const parseResult = z.string().uuid().safeParse(itemId)
  if (!parseResult.success) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Invalid item ID format', 400)
  }

  const item = await getItem(c.env.DB, c.env.STORAGE, userId, parseResult.data, vaultId)
  return c.json(item)
}

// Pack discovery for bootstrap (#1839). Paginated newest-first; presigned GET
// per pack when the deployment opted into direct R2 transfers. Additive and
// unused by old clients — the item-granular endpoints remain the source of
// truth, packs are a derived cache on top.
const packsRateLimit = createRateLimiter({
  keyPrefix: 'sync_packs',
  maxRequests: 60,
  windowSeconds: 60
})

const handleListPacks = async (c: Context<AppContext>): Promise<Response> => {
  const userId = c.get('userId')!
  const vaultId = c.get('vaultId')!
  const endpoint = getRequestPath(c)

  const limitParam = c.req.query('limit')
  const cursorParam = c.req.query('cursor')

  let limit: number | undefined
  if (limitParam !== undefined) {
    limit = parseInt(limitParam, 10)
    if (isNaN(limit) || limit < 1) {
      logQueryValidationFailure('record', endpoint, 'Invalid limit value')
    }
  }
  if (cursorParam !== undefined && !/^\d+:\S+$/.test(cursorParam)) {
    logQueryValidationFailure('record', endpoint, 'Invalid cursor value', 'SYNC_INVALID_CURSOR')
  }

  const result = await listPacks(
    c.env.DB,
    userId,
    vaultId,
    { cursor: cursorParam ?? null, limit },
    resolveR2PresignConfig(c.env)
  )
  return c.json(result)
}

const recordSync = new Hono<AppContext>()

recordSync.get('/status', statusRateLimit, handleRecordStatus)
recordSync.get('/manifest', manifestRateLimit, handleRecordManifest)
recordSync.get('/changes', changesRateLimit, handleRecordChanges)
recordSync.post('/push', pushRateLimit, handleRecordPush)
recordSync.post('/pull', pullRateLimit, handleRecordPull)
recordSync.get('/items/:id', handleRecordItem)
recordSync.get('/packs', packsRateLimit, handleListPacks)

sync.route('/records', recordSync)

sync.get('/status', statusRateLimit, handleRecordStatus)
sync.get('/manifest', manifestRateLimit, handleRecordManifest)
sync.get('/changes', changesRateLimit, handleRecordChanges)
sync.post('/push', pushRateLimit, handleRecordPush)
sync.post('/pull', pullRateLimit, handleRecordPull)
sync.get('/items/:id', handleRecordItem)
sync.get('/packs', packsRateLimit, handleListPacks)

// ============================================================================
// CRDT Endpoints
// ============================================================================

const NoteIdSchema = z
  .string()
  .regex(/^[a-zA-Z0-9_-]+$/)
  .max(128)

// The CRDT budgets are per device, not per account. Body sync is device-local
// work: each device pulls the note bodies it does not have yet, and a second
// device on the same account is normal use rather than contention. Under the
// default per-user bucket the two devices split one budget, so signing in on
// device B made device A's ordinary syncing start failing with 429s. Requests
// without a deviceId keep the userId/IP fallback, so nothing gets less strict.
const crdtPushRateLimit = createRateLimiter({
  keyPrefix: 'crdt_push',
  maxRequests: 300,
  windowSeconds: 60,
  identifier: deviceIdentifier
})

// Sized for one device pulling an entire vault's bodies after a fresh sign-in.
// That sweep costs two GETs per note (snapshot + updates), so a 121-note vault
// spends ~242 requests in a few seconds; 600/min leaves room for a vault twice
// that size plus the normal editing traffic running alongside it. The client
// paces and batches its sweep, so treat this ceiling as the safety margin for
// when that pacing is wrong or missing, not as the thing shaping the traffic.
const crdtPullRateLimit = createRateLimiter({
  keyPrefix: 'crdt_pull',
  maxRequests: 600,
  windowSeconds: 60,
  identifier: deviceIdentifier
})

const crdtBatchPullRateLimit = createRateLimiter({
  keyPrefix: 'crdt_batch_pull',
  maxRequests: 30,
  windowSeconds: 60,
  identifier: deviceIdentifier
})

const CrdtBatchPullSchema = z.object({
  notes: z
    .array(
      z.object({
        noteId: NoteIdSchema,
        since: z.number().int().nonnegative().default(0)
      })
    )
    .min(1)
    .max(100)
    .refine(
      (arr) => new Set(arr.map((n) => n.noteId)).size === arr.length,
      'Duplicate noteIds are not allowed'
    ),
  limit: z.number().int().min(1).max(100).default(100)
})

const CrdtPushSchema = z.object({
  noteId: NoteIdSchema,
  updates: z.array(z.string().max(MAX_UPDATE_BYTES * 2)).max(100)
})

const CrdtSnapshotPushSchema = z.object({
  noteId: NoteIdSchema,
  snapshot: z.string()
})

const handleCrdtUpdatePush = async (c: Context<AppContext>): Promise<Response> => {
  const userId = c.get('userId')!
  const deviceId = c.get('deviceId')!
  const vaultId = c.get('vaultId')!
  const endpoint = getRequestPath(c)
  const startedAt = Date.now()
  const body = await c.req.json()
  const parsed = parseTransportRequest(CrdtPushSchema, body, {
    transport: 'crdt',
    endpoint,
    label: 'CRDT updates request'
  })

  const buffers = parsed.updates.map((payload) =>
    decodeCrdtPayload(payload, endpoint, 'Individual update exceeds 5MB limit')
  )

  const totalBytes = buffers.reduce((sum, buf) => sum + buf.byteLength, 0)
  let sequences: number[]
  try {
    sequences = await storeUpdates(
      c.env.DB,
      userId,
      vaultId,
      parsed.noteId,
      deviceId,
      buffers,
      c.get('client') ?? null
    )
  } catch (error) {
    if (error instanceof AppError && error.code === ErrorCodes.STORAGE_QUOTA_EXCEEDED) {
      logCrdtTraffic({
        endpoint,
        event: 'updates_rejected',
        noteId: parsed.noteId,
        updateCount: parsed.updates.length,
        totalBytes,
        latencyMs: Date.now() - startedAt,
        reason: error.code
      })
    }
    throw error
  }

  const doId = c.env.USER_SYNC_STATE.idFromName(userId)
  const stub = c.env.USER_SYNC_STATE.get(doId)
  waitUntilCaptured(
    c,
    stub.fetch(
      new Request(new URL('/broadcast', c.req.url), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          excludeDeviceId: deviceId,
          vaultId,
          type: 'crdt_updated',
          noteId: parsed.noteId
        })
      })
    ),
    { source: 'UserSyncState', action: 'crdt_update_broadcast_failed' }
  )

  logCrdtTraffic({
    endpoint,
    event: 'updates_stored',
    noteId: parsed.noteId,
    updateCount: sequences.length,
    totalBytes,
    latencyMs: Date.now() - startedAt
  })

  return c.json({ sequences })
}

const handleCrdtUpdatePull = async (c: Context<AppContext>): Promise<Response> => {
  const userId = c.get('userId')!
  const vaultId = c.get('vaultId')!
  const endpoint = getRequestPath(c)
  const startedAt = Date.now()
  const noteIdRaw = c.req.query('note_id')
  const since = parseInt(c.req.query('since') ?? '0', 10)
  const limit = parseInt(c.req.query('limit') ?? '100', 10)

  if (!noteIdRaw) {
    logQueryValidationFailure('crdt', endpoint, 'note_id is required')
  }
  const noteId = noteIdRaw
  const noteIdResult = NoteIdSchema.safeParse(noteId)
  if (!noteIdResult.success) {
    logQueryValidationFailure('crdt', endpoint, 'Invalid note_id format')
  }
  if (isNaN(since) || since < 0) {
    logQueryValidationFailure('crdt', endpoint, 'Invalid since value')
  }
  if (isNaN(limit) || limit < 1) {
    logQueryValidationFailure('crdt', endpoint, 'Invalid limit value')
  }

  const result = await getUpdates(
    c.env.DB,
    userId,
    vaultId,
    noteIdResult.data,
    since,
    Math.min(limit, 500)
  )

  const encoded = result.updates.map((u) => ({
    sequenceNum: u.sequence_num,
    data: safeBase64Encode(u.update_data as ArrayBuffer),
    signerDeviceId: u.signer_device_id,
    createdAt: u.created_at
  }))

  logCrdtTraffic({
    endpoint,
    event: 'updates_fetched',
    noteId: noteIdResult.data,
    updateCount: encoded.length,
    totalBytes: result.updates.reduce((sum, update) => sum + update.update_data.byteLength, 0),
    latencyMs: Date.now() - startedAt
  })

  return c.json({ updates: encoded, hasMore: result.hasMore })
}

const handleCrdtBatchPull = async (c: Context<AppContext>): Promise<Response> => {
  const userId = c.get('userId')!
  const vaultId = c.get('vaultId')!
  const endpoint = getRequestPath(c)
  const startedAt = Date.now()
  const body: unknown = await c.req.json()
  const parsed = parseTransportRequest(CrdtBatchPullSchema, body, {
    transport: 'crdt',
    endpoint,
    label: 'CRDT batch request'
  })

  const batchResult = await getBatchUpdates(c.env.DB, userId, vaultId, parsed.notes, parsed.limit)

  const response: Record<string, { updates: unknown[]; hasMore: boolean }> = {}
  for (const [noteId, result] of Object.entries(batchResult.notes)) {
    response[noteId] = {
      updates: result.updates.map((update) => ({
        sequenceNum: update.sequence_num,
        data: safeBase64Encode(update.update_data as ArrayBuffer),
        signerDeviceId: update.signer_device_id,
        createdAt: update.created_at
      })),
      hasMore: result.hasMore
    }
  }

  logCrdtTraffic({
    endpoint,
    event: 'batch_fetched',
    noteCount: parsed.notes.length,
    updateCount: Object.values(batchResult.notes).reduce(
      (sum, result) => sum + result.updates.length,
      0
    ),
    totalBytes: Object.values(batchResult.notes).reduce(
      (sum, result) =>
        sum +
        result.updates.reduce((noteSum, update) => noteSum + update.update_data.byteLength, 0),
      0
    ),
    latencyMs: Date.now() - startedAt
  })

  // `snapshotMeta` is additive and present on every response from a server that
  // supports it, so a client can tell "the server is old" (key absent) from "the
  // server has no snapshot for this note" (key present, note absent). Old
  // clients read this response through an unvalidated TypeScript cast, so the
  // extra key is ignored.
  return c.json({ notes: response, snapshotMeta: batchResult.snapshotMeta })
}

const handleCrdtSnapshotPush = async (c: Context<AppContext>): Promise<Response> => {
  const userId = c.get('userId')!
  const deviceId = c.get('deviceId')!
  const vaultId = c.get('vaultId')!
  const endpoint = getRequestPath(c)
  const startedAt = Date.now()
  const body = await c.req.json()
  const parsed = parseTransportRequest(CrdtSnapshotPushSchema, body, {
    transport: 'crdt',
    endpoint,
    label: 'CRDT snapshot request'
  })

  const snapshotBytes = decodeCrdtPayload(parsed.snapshot, endpoint, 'Snapshot exceeds 5MB limit')

  let result: { sequenceNum: number }
  try {
    result = await storeSnapshot(
      c.env.DB,
      c.env.STORAGE,
      userId,
      vaultId,
      parsed.noteId,
      deviceId,
      snapshotBytes,
      c.get('client') ?? null
    )
  } catch (error) {
    if (error instanceof AppError && error.code === ErrorCodes.STORAGE_QUOTA_EXCEEDED) {
      logCrdtTraffic({
        endpoint,
        event: 'snapshot_rejected',
        noteId: parsed.noteId,
        totalBytes: snapshotBytes.byteLength,
        latencyMs: Date.now() - startedAt,
        reason: error.code
      })
    }
    throw error
  }

  await pruneUpdatesBeforeSnapshot(c.env.DB, userId, vaultId, parsed.noteId)

  // Snapshot pushes are pack candidates too (#1839): nudge after the store +
  // prune settle, best-effort, same reasoning as the record push path.
  waitUntilCaptured(
    c,
    enqueuePackCompaction(c.env, { userId, vaultId }),
    { source: 'PackQueue', action: 'pack_enqueue_failed' }
  )

  // A snapshot is a body write like any other and has to wake the peers the way
  // an incremental does. It is not a duplicate of the update path: a device that
  // edited while signed out never enqueued those edits as updates — they exist
  // only as document state — so a snapshot is the only shape they can leave in.
  // Silently stored, that backlog stayed invisible on every other device, because
  // note bodies never travel in the record feed and the next vault sweep is up to
  // 15 minutes away. Typing one more character used to be the only cure: the
  // incremental broadcast, and the pull it triggered picked up the snapshot too.
  //
  // Ordering is deliberate — after the store and after the prune, never between
  // them, so a peer is never told to pull while the pre-snapshot updates are
  // still being removed. Delivery is best-effort for the same reason as the
  // update path: the write already succeeded, so a failed broadcast is captured
  // in the background rather than returned as an error the client would retry.
  const doId = c.env.USER_SYNC_STATE.idFromName(userId)
  const stub = c.env.USER_SYNC_STATE.get(doId)
  waitUntilCaptured(
    c,
    stub.fetch(
      new Request(new URL('/broadcast', c.req.url), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          excludeDeviceId: deviceId,
          vaultId,
          type: 'crdt_updated',
          noteId: parsed.noteId
        })
      })
    ),
    { source: 'UserSyncState', action: 'crdt_snapshot_broadcast_failed' }
  )

  logCrdtTraffic({
    endpoint,
    event: 'snapshot_stored',
    noteId: parsed.noteId,
    totalBytes: snapshotBytes.byteLength,
    sequenceNum: result.sequenceNum,
    latencyMs: Date.now() - startedAt
  })

  return c.json({ sequenceNum: result.sequenceNum })
}

const handleCrdtSnapshotPull = async (c: Context<AppContext>): Promise<Response> => {
  const userId = c.get('userId')!
  const vaultId = c.get('vaultId')!
  const endpoint = getRequestPath(c)
  const startedAt = Date.now()
  const noteIdRaw = c.req.param('noteId')

  const noteIdResult = NoteIdSchema.safeParse(noteIdRaw)
  if (!noteIdResult.success) {
    logQueryValidationFailure('crdt', endpoint, 'Invalid noteId format')
  }

  const result = await getSnapshot(c.env.DB, c.env.STORAGE, userId, vaultId, noteIdResult.data)
  if (!result) {
    logCrdtTraffic({
      endpoint,
      event: 'snapshot_fetched',
      noteId: noteIdResult.data,
      totalBytes: 0,
      sequenceNum: 0,
      latencyMs: Date.now() - startedAt
    })
    return c.json({ snapshot: null, sequenceNum: 0, signerDeviceId: null, revision: null })
  }

  logCrdtTraffic({
    endpoint,
    event: 'snapshot_fetched',
    noteId: noteIdResult.data,
    totalBytes: result.snapshotData.byteLength,
    sequenceNum: result.sequenceNum,
    latencyMs: Date.now() - startedAt
  })

  // The revision the client just merged, so the next batch pull can tell it this
  // baseline is still current and skip the download.
  return c.json({
    snapshot: safeBase64Encode(result.snapshotData),
    sequenceNum: result.sequenceNum,
    signerDeviceId: result.signerDeviceId,
    revision: result.revision
  })
}

const crdtSync = new Hono<AppContext>()

crdtSync.post('/updates', crdtPushRateLimit, handleCrdtUpdatePush)
crdtSync.get('/updates', crdtPullRateLimit, handleCrdtUpdatePull)
crdtSync.post('/updates/batch', crdtBatchPullRateLimit, handleCrdtBatchPull)
crdtSync.post('/snapshot', crdtPushRateLimit, handleCrdtSnapshotPush)
crdtSync.get('/snapshot/:noteId', crdtPullRateLimit, handleCrdtSnapshotPull)

sync.route('/crdt', crdtSync)
