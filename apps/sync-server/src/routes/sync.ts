import { Hono } from 'hono'
import { z } from 'zod'

import { PullRequestSchema, PushRequestSchema } from '@memry/contracts/sync-api'
import { AppError, ErrorCodes } from '../lib/errors'
import { authMiddleware } from '../middleware/auth'
import { createRateLimiter } from '../middleware/rate-limit'
import {
  getChanges,
  getItem,
  getManifest,
  getSyncStatus,
  processPushItem,
  pullItems,
  updateDeviceCursor
} from '../services/sync'
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

sync.get('/status', statusRateLimit, async (c) => {
  const userId = c.get('userId')!
  const deviceId = c.get('deviceId')!
  const status = await getSyncStatus(c.env.DB, userId, deviceId)
  return c.json(status)
})

sync.get('/manifest', manifestRateLimit, async (c) => {
  const userId = c.get('userId')!
  const manifest = await getManifest(c.env.DB, userId)
  return c.json(manifest)
})

sync.get('/changes', changesRateLimit, async (c) => {
  const userId = c.get('userId')!
  const deviceId = c.get('deviceId')!

  const cursorParam = c.req.query('cursor')
  const limitParam = c.req.query('limit')

  const cursor = cursorParam ? parseInt(cursorParam, 10) : 0
  if (isNaN(cursor) || cursor < 0) {
    throw new AppError(ErrorCodes.SYNC_INVALID_CURSOR, 'Invalid cursor value', 400)
  }

  const limit = limitParam ? parseInt(limitParam, 10) : undefined
  if (limit !== undefined && (isNaN(limit) || limit < 1)) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Invalid limit value', 400)
  }

  const changes = await getChanges(c.env.DB, userId, cursor, limit)

  if (changes.items.length > 0 || changes.deleted.length > 0) {
    await updateDeviceCursor(c.env.DB, deviceId, userId, changes.nextCursor)
    await updateDevice(c.env.DB, deviceId, userId, {
      last_sync_at: Math.floor(Date.now() / 1000)
    })
  }

  return c.json(changes)
})

sync.post('/push', pushRateLimit, async (c) => {
  const userId = c.get('userId')!
  const deviceId = c.get('deviceId')!

  const body: unknown = await c.req.json()
  const parsed = PushRequestSchema.safeParse(body)
  if (!parsed.success) {
    throw new AppError(
      ErrorCodes.VALIDATION_ERROR,
      `Invalid push request: ${parsed.error.issues[0]?.message ?? 'validation failed'}`,
      400
    )
  }

  const estimatedBytes = JSON.stringify(parsed.data.items).length
  await checkQuota(c.env.DB, userId, estimatedBytes)

  const accepted: string[] = []
  const rejected: Array<{ id: string; reason: string }> = []
  let maxCursor = 0

  for (const item of parsed.data.items) {
    const result = await processPushItem(c.env.DB, c.env.STORAGE, userId, deviceId, item)
    if (result.accepted) {
      accepted.push(item.id)
      if (result.serverCursor && result.serverCursor > maxCursor) {
        maxCursor = result.serverCursor
      }
    } else {
      rejected.push({ id: item.id, reason: result.reason ?? 'UNKNOWN' })
    }
  }

  if (maxCursor > 0) {
    await updateDeviceCursor(c.env.DB, deviceId, userId, maxCursor)
  }

  if (accepted.length > 0) {
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
          body: JSON.stringify({ excludeDeviceId: deviceId, cursor: maxCursor })
        })
      )
    )
  }

  return c.json({
    accepted,
    rejected,
    serverTime: Math.floor(Date.now() / 1000),
    maxCursor
  })
})

sync.post('/pull', pullRateLimit, async (c) => {
  const userId = c.get('userId')!

  const body: unknown = await c.req.json()
  const parsed = PullRequestSchema.safeParse(body)
  if (!parsed.success) {
    throw new AppError(
      ErrorCodes.VALIDATION_ERROR,
      `Invalid pull request: ${parsed.error.issues[0]?.message ?? 'validation failed'}`,
      400
    )
  }

  const items = await pullItems(c.env.DB, c.env.STORAGE, userId, parsed.data.itemIds)
  return c.json({ items })
})

sync.get('/items/:id', async (c) => {
  const userId = c.get('userId')!
  const itemId = c.req.param('id')

  const parseResult = z.string().uuid().safeParse(itemId)
  if (!parseResult.success) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Invalid item ID format', 400)
  }

  const item = await getItem(c.env.DB, c.env.STORAGE, userId, itemId)
  return c.json(item)
})

// ============================================================================
// CRDT Endpoints
// ============================================================================

const MAX_UPDATE_BYTES = 5 * 1024 * 1024 // 5MB per individual update
const BASE64_CHUNK_SIZE = 8192

function safeBase64Encode(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let result = ''
  for (let i = 0; i < bytes.length; i += BASE64_CHUNK_SIZE) {
    const chunk = bytes.subarray(i, i + BASE64_CHUNK_SIZE)
    result += String.fromCharCode(...chunk)
  }
  return btoa(result)
}

function safeBase64Decode(b64: string): Uint8Array {
  const raw = atob(b64)
  const bytes = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) {
    bytes[i] = raw.charCodeAt(i)
  }
  return bytes
}

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

sync.post('/crdt/updates', crdtPushRateLimit, async (c) => {
  const userId = c.get('userId')!
  const deviceId = c.get('deviceId')!
  const body = await c.req.json()
  const parsed = CrdtPushSchema.parse(body)

  const buffers = parsed.updates.map((b64) => {
    const bytes = safeBase64Decode(b64)
    if (bytes.byteLength > MAX_UPDATE_BYTES) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Individual update exceeds 5MB limit', 413)
    }
    return bytes.buffer as ArrayBuffer
  })

  const totalBytes = buffers.reduce((sum, buf) => sum + buf.byteLength, 0)
  await checkQuota(c.env.DB, userId, totalBytes)

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

  return c.json({ sequences })
})

sync.get('/crdt/updates', crdtPullRateLimit, async (c) => {
  const userId = c.get('userId')!
  const noteIdRaw = c.req.query('note_id')
  const since = parseInt(c.req.query('since') ?? '0', 10)
  const limit = parseInt(c.req.query('limit') ?? '100', 10)

  if (!noteIdRaw) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'note_id is required', 400)
  }
  const noteIdResult = NoteIdSchema.safeParse(noteIdRaw)
  if (!noteIdResult.success) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Invalid note_id format', 400)
  }
  const noteId = noteIdResult.data

  const result = await getUpdates(c.env.DB, userId, noteId, since, Math.min(limit, 500))

  const encoded = result.updates.map((u) => ({
    sequenceNum: u.sequence_num,
    data: safeBase64Encode(u.update_data as ArrayBuffer),
    signerDeviceId: u.signer_device_id,
    createdAt: u.created_at
  }))

  return c.json({ updates: encoded, hasMore: result.hasMore })
})

sync.post('/crdt/updates/batch', crdtBatchPullRateLimit, async (c) => {
  const userId = c.get('userId')!
  const body: unknown = await c.req.json()
  const parsed = CrdtBatchPullSchema.safeParse(body)
  if (!parsed.success) {
    throw new AppError(
      ErrorCodes.VALIDATION_ERROR,
      `Invalid batch request: ${parsed.error.issues[0]?.message ?? 'validation failed'}`,
      400
    )
  }

  const { notes, limit } = parsed.data
  const batchResult = await getBatchUpdates(c.env.DB, userId, notes, limit)

  const response: Record<string, { updates: unknown[]; hasMore: boolean }> = {}
  for (const [noteId, r] of Object.entries(batchResult)) {
    response[noteId] = {
      updates: r.updates.map((u) => ({
        sequenceNum: u.sequence_num,
        data: safeBase64Encode(u.update_data as ArrayBuffer),
        signerDeviceId: u.signer_device_id,
        createdAt: u.created_at
      })),
      hasMore: r.hasMore
    }
  }
  return c.json({ notes: response })
})

const CrdtSnapshotPushSchema = z.object({
  noteId: NoteIdSchema,
  snapshot: z.string()
})

sync.post('/crdt/snapshot', crdtPushRateLimit, async (c) => {
  const userId = c.get('userId')!
  const deviceId = c.get('deviceId')!
  const body = await c.req.json()
  const parsed = CrdtSnapshotPushSchema.parse(body)

  const bytes = safeBase64Decode(parsed.snapshot)
  if (bytes.byteLength > MAX_UPDATE_BYTES) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Snapshot exceeds 5MB limit', 413)
  }

  await checkQuota(c.env.DB, userId, bytes.byteLength)

  const result = await storeSnapshot(
    c.env.DB,
    c.env.STORAGE,
    userId,
    parsed.noteId,
    deviceId,
    bytes.buffer as ArrayBuffer
  )

  await pruneUpdatesBeforeSnapshot(c.env.DB, userId, parsed.noteId)

  return c.json({ sequenceNum: result.sequenceNum })
})

sync.get('/crdt/snapshot/:noteId', crdtPullRateLimit, async (c) => {
  const userId = c.get('userId')!
  const noteIdRaw = c.req.param('noteId')

  const noteIdResult = NoteIdSchema.safeParse(noteIdRaw)
  if (!noteIdResult.success) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Invalid noteId format', 400)
  }

  const result = await getSnapshot(c.env.DB, c.env.STORAGE, userId, noteIdResult.data)
  if (!result) {
    return c.json({ snapshot: null, sequenceNum: 0, signerDeviceId: null })
  }

  const encoded = safeBase64Encode(result.snapshotData)
  return c.json({
    snapshot: encoded,
    sequenceNum: result.sequenceNum,
    signerDeviceId: result.signerDeviceId
  })
})
