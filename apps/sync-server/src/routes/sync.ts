import type { Context } from 'hono'
import { Hono } from 'hono'
import { z } from 'zod'

import { PullRequestSchema, PushRequestSchema } from '@memry/contracts/sync-api'
import { safeBase64Decode } from '../lib/encoding'
import { AppError, ErrorCodes } from '../lib/errors'
import { authMiddleware } from '../middleware/auth'
import { createRateLimiter } from '../middleware/rate-limit'
import {
  getChanges,
  getItem,
  getManifest,
  getSyncStatus,
  processRecordPushBatch,
  pullItems,
  updateDeviceCursor
} from '../services/sync'
import {
  logCrdtTraffic,
  logRecordPushBatch,
  logRecordQueryBatch,
  logSyncValidationFailure
} from '../services/sync-telemetry'
import { updateDevice } from '../services/device'
import { checkQuota } from '../services/quota'
import { getStorageBreakdown } from '../services/storage'
import {
  storeUpdates,
  getUpdates,
  getBatchUpdates,
  storeSnapshot,
  getSnapshot,
  pruneUpdatesBeforeSnapshot
} from '../services/crdt'
import type { AppContext } from '../types'

export const sync = new Hono<AppContext>()

sync.use('*', authMiddleware)

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

const manifestRateLimit = createRateLimiter({
  keyPrefix: 'sync_manifest',
  maxRequests: 10,
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
  const id = c.env.USER_SYNC_STATE.idFromName(userId)
  const stub = c.env.USER_SYNC_STATE.get(id)
  return stub.fetch(
    new Request(new URL('/connect', c.req.url), {
      headers: c.req.raw.headers
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
  const status = await getSyncStatus(c.env.DB, userId, deviceId)
  return c.json(status)
}

const handleRecordManifest = async (c: Context<AppContext>): Promise<Response> => {
  const userId = c.get('userId')!
  const manifest = await getManifest(c.env.DB, userId)
  return c.json(manifest)
}

const handleRecordChanges = async (c: Context<AppContext>): Promise<Response> => {
  const userId = c.get('userId')!
  const deviceId = c.get('deviceId')!
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

  const changes = await getChanges(c.env.DB, userId, cursor, limit)

  if (changes.items.length > 0 || changes.deleted.length > 0) {
    await updateDeviceCursor(c.env.DB, deviceId, userId, changes.nextCursor)
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
  const endpoint = getRequestPath(c)
  const startedAt = Date.now()

  const body: unknown = await c.req.json()
  const parsed = parseTransportRequest(PushRequestSchema, body, {
    transport: 'record',
    endpoint,
    label: 'push request'
  })

  let result
  try {
    result = await processRecordPushBatch(c.env.DB, c.env.STORAGE, userId, deviceId, parsed.items)
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
    await updateDeviceCursor(c.env.DB, deviceId, userId, result.maxCursor)
  }

  if (result.accepted.length > 0) {
    await updateDevice(c.env.DB, deviceId, userId, {
      last_sync_at: Math.floor(Date.now() / 1000)
    })
    const doId = c.env.USER_SYNC_STATE.idFromName(userId)
    const stub = c.env.USER_SYNC_STATE.get(doId)
    c.executionCtx.waitUntil(
      stub.fetch(
        new Request(new URL('/broadcast', c.req.url), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ excludeDeviceId: deviceId, cursor: result.maxCursor })
        })
      )
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
  const endpoint = getRequestPath(c)
  const startedAt = Date.now()

  const body: unknown = await c.req.json()
  const parsed = parseTransportRequest(PullRequestSchema, body, {
    transport: 'record',
    endpoint,
    label: 'pull request'
  })

  const items = await pullItems(c.env.DB, c.env.STORAGE, userId, parsed.itemIds)
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
  const itemId = c.req.param('id')

  const parseResult = z.string().uuid().safeParse(itemId)
  if (!parseResult.success) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Invalid item ID format', 400)
  }

  const item = await getItem(c.env.DB, c.env.STORAGE, userId, parseResult.data)
  return c.json(item)
}

const recordSync = new Hono<AppContext>()

recordSync.get('/status', statusRateLimit, handleRecordStatus)
recordSync.get('/manifest', manifestRateLimit, handleRecordManifest)
recordSync.get('/changes', changesRateLimit, handleRecordChanges)
recordSync.post('/push', pushRateLimit, handleRecordPush)
recordSync.post('/pull', pullRateLimit, handleRecordPull)
recordSync.get('/items/:id', handleRecordItem)

sync.route('/records', recordSync)

sync.get('/status', statusRateLimit, handleRecordStatus)
sync.get('/manifest', manifestRateLimit, handleRecordManifest)
sync.get('/changes', changesRateLimit, handleRecordChanges)
sync.post('/push', pushRateLimit, handleRecordPush)
sync.post('/pull', pullRateLimit, handleRecordPull)
sync.get('/items/:id', handleRecordItem)

// ============================================================================
// CRDT Endpoints
// ============================================================================

const NoteIdSchema = z
  .string()
  .regex(/^[a-zA-Z0-9_-]+$/)
  .max(128)

const crdtPushRateLimit = createRateLimiter({
  keyPrefix: 'crdt_push',
  maxRequests: 300,
  windowSeconds: 60
})

const crdtPullRateLimit = createRateLimiter({
  keyPrefix: 'crdt_pull',
  maxRequests: 300,
  windowSeconds: 60
})

const crdtBatchPullRateLimit = createRateLimiter({
  keyPrefix: 'crdt_batch_pull',
  maxRequests: 30,
  windowSeconds: 60
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
  try {
    await checkQuota(c.env.DB, userId, totalBytes)
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

  const sequences = await storeUpdates(c.env.DB, userId, parsed.noteId, deviceId, buffers)

  const doId = c.env.USER_SYNC_STATE.idFromName(userId)
  const stub = c.env.USER_SYNC_STATE.get(doId)
  c.executionCtx.waitUntil(
    stub.fetch(
      new Request(new URL('/broadcast', c.req.url), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          excludeDeviceId: deviceId,
          type: 'crdt_updated',
          noteId: parsed.noteId
        })
      })
    )
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

  const result = await getUpdates(c.env.DB, userId, noteIdResult.data, since, Math.min(limit, 500))

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
  const endpoint = getRequestPath(c)
  const startedAt = Date.now()
  const body: unknown = await c.req.json()
  const parsed = parseTransportRequest(CrdtBatchPullSchema, body, {
    transport: 'crdt',
    endpoint,
    label: 'CRDT batch request'
  })

  const batchResult = await getBatchUpdates(c.env.DB, userId, parsed.notes, parsed.limit)

  const response: Record<string, { updates: unknown[]; hasMore: boolean }> = {}
  for (const [noteId, result] of Object.entries(batchResult)) {
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
    updateCount: Object.values(batchResult).reduce((sum, result) => sum + result.updates.length, 0),
    totalBytes: Object.values(batchResult).reduce(
      (sum, result) =>
        sum + result.updates.reduce((noteSum, update) => noteSum + update.update_data.byteLength, 0),
      0
    ),
    latencyMs: Date.now() - startedAt
  })

  return c.json({ notes: response })
}

const handleCrdtSnapshotPush = async (c: Context<AppContext>): Promise<Response> => {
  const userId = c.get('userId')!
  const deviceId = c.get('deviceId')!
  const endpoint = getRequestPath(c)
  const startedAt = Date.now()
  const body = await c.req.json()
  const parsed = parseTransportRequest(CrdtSnapshotPushSchema, body, {
    transport: 'crdt',
    endpoint,
    label: 'CRDT snapshot request'
  })

  const snapshotBytes = decodeCrdtPayload(parsed.snapshot, endpoint, 'Snapshot exceeds 5MB limit')

  try {
    await checkQuota(c.env.DB, userId, snapshotBytes.byteLength)
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

  const result = await storeSnapshot(
    c.env.DB,
    c.env.STORAGE,
    userId,
    parsed.noteId,
    deviceId,
    snapshotBytes
  )

  await pruneUpdatesBeforeSnapshot(c.env.DB, userId, parsed.noteId)

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
  const endpoint = getRequestPath(c)
  const startedAt = Date.now()
  const noteIdRaw = c.req.param('noteId')

  const noteIdResult = NoteIdSchema.safeParse(noteIdRaw)
  if (!noteIdResult.success) {
    logQueryValidationFailure('crdt', endpoint, 'Invalid noteId format')
  }

  const result = await getSnapshot(c.env.DB, c.env.STORAGE, userId, noteIdResult.data)
  if (!result) {
    logCrdtTraffic({
      endpoint,
      event: 'snapshot_fetched',
      noteId: noteIdResult.data,
      totalBytes: 0,
      sequenceNum: 0,
      latencyMs: Date.now() - startedAt
    })
    return c.json({ snapshot: null, sequenceNum: 0, signerDeviceId: null })
  }

  logCrdtTraffic({
    endpoint,
    event: 'snapshot_fetched',
    noteId: noteIdResult.data,
    totalBytes: result.snapshotData.byteLength,
    sequenceNum: result.sequenceNum,
    latencyMs: Date.now() - startedAt
  })

  return c.json({
    snapshot: safeBase64Encode(result.snapshotData),
    sequenceNum: result.sequenceNum,
    signerDeviceId: result.signerDeviceId
  })
}

const crdtSync = new Hono<AppContext>()

crdtSync.post('/updates', crdtPushRateLimit, handleCrdtUpdatePush)
crdtSync.get('/updates', crdtPullRateLimit, handleCrdtUpdatePull)
crdtSync.post('/updates/batch', crdtBatchPullRateLimit, handleCrdtBatchPull)
crdtSync.post('/snapshot', crdtPushRateLimit, handleCrdtSnapshotPush)
crdtSync.get('/snapshot/:noteId', crdtPullRateLimit, handleCrdtSnapshotPull)

sync.route('/crdt', crdtSync)
