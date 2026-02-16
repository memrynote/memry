import { Hono } from 'hono'
import { z } from 'zod'

import { PullRequestSchema, PushRequestSchema } from '../contracts/sync-api'
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
  maxRequests: 30,
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
  maxRequests: 5,
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
    await updateDevice(c.env.DB, deviceId, {
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
    await updateDevice(c.env.DB, deviceId, {
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
    serverTime: Math.floor(Date.now() / 1000)
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
