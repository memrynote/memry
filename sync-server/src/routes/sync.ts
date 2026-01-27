/**
 * Sync Routes
 *
 * Implements all sync endpoints:
 * - T082: GET /sync/status
 * - T083: GET /sync/manifest
 * - T084: GET /sync/changes
 * - T085: POST /sync/push
 * - T086: POST /sync/pull
 * - T087: GET /sync/items/:id
 * - T088: DELETE /sync/items/:id
 */

import { Hono } from 'hono'
import { z } from 'zod'
import type { Env } from '../index'
import type { AuthContext } from '../middleware/auth'
import { getAuth } from '../middleware/auth'
import { validationError, badRequest, notFound } from '../lib/errors'
import {
  getSyncItem,
  getSyncItems,
  getSyncManifest,
  getSyncChanges,
  pushSyncItems,
  softDeleteSyncItem,
  getSyncStatus,
  updateDeviceCursorState
} from '../services/sync'
import { updateDeviceLastSyncAt } from '../services/device'
import {
  SYNC_ITEM_TYPES,
  type SyncItemType,
  type SyncStatusResponse,
  type PullSyncResponse,
  type PushSyncResponse,
  PushSyncRequestSchema
} from '../contracts/sync-api'
import { crdtRoutes } from './crdt'

interface SyncVariables {
  auth: AuthContext
}

// Internal DO routing URL - Durable Objects use pathname-based routing
// and the host/scheme are ignored for internal fetch calls
const DO_BROADCAST_URL = 'http://internal/broadcast'
const LOG_PREFIX = '[SyncServer]'

const syncRoutes = new Hono<{ Bindings: Env; Variables: SyncVariables }>()

// Mount CRDT routes at /crdt
syncRoutes.route('/crdt', crdtRoutes)

// =============================================================================
// Request Schemas
// =============================================================================

const ManifestQuerySchema = z.object({
  types: z
    .string()
    .optional()
    .transform((val) => {
      if (!val) return undefined
      return val
        .split(',')
        .filter((t) => SYNC_ITEM_TYPES.includes(t as SyncItemType)) as SyncItemType[]
    })
})

const ChangesQuerySchema = z.object({
  cursor: z.coerce.number().int().nonnegative(),
  limit: z.coerce.number().int().positive().max(100).default(50),
  types: z
    .string()
    .optional()
    .transform((val) => {
      if (!val) return undefined
      return val
        .split(',')
        .filter((t) => SYNC_ITEM_TYPES.includes(t as SyncItemType)) as SyncItemType[]
    })
})

const PullRequestSchema = z.object({
  itemIds: z.array(z.string().min(1).max(128)).max(100)
})

// =============================================================================
// T082: GET /sync/status
// =============================================================================

syncRoutes.get('/status', async (c) => {
  const auth = getAuth(c)

  const status = await getSyncStatus(c.env.DB, auth.userId, auth.deviceId)

  const response: SyncStatusResponse = {
    status: status.status,
    serverCursor: status.serverCursor,
    pendingItems: status.pendingItems,
    lastSyncAt: status.lastSyncAt ?? undefined,
    storageUsed: status.storageUsed,
    storageLimit: status.storageLimit
  }

  return c.json(response)
})

// =============================================================================
// T083: GET /sync/manifest
// =============================================================================

syncRoutes.get('/manifest', async (c) => {
  const auth = getAuth(c)

  const parsed = ManifestQuerySchema.safeParse(c.req.query())
  if (!parsed.success) {
    throw validationError('Invalid query parameters', { issues: parsed.error.issues })
  }

  const { types } = parsed.data
  const manifest = await getSyncManifest(c.env.DB, auth.userId, types)

  return c.json({ items: manifest })
})

// =============================================================================
// T084: GET /sync/changes
// =============================================================================

syncRoutes.get('/changes', async (c) => {
  const auth = getAuth(c)

  const parsed = ChangesQuerySchema.safeParse(c.req.query())
  if (!parsed.success) {
    throw validationError('Invalid query parameters', { issues: parsed.error.issues })
  }

  const { cursor, limit, types } = parsed.data
  console.log(`${LOG_PREFIX} GET /sync/changes`, { cursor, limit, types })
  const result = await getSyncChanges(c.env.DB, auth.userId, cursor, limit, types)

  await updateDeviceCursorState(c.env.DB, auth.userId, auth.deviceId, result.nextCursor)
  await updateDeviceLastSyncAt(c.env.DB, auth.deviceId)

  const response: PullSyncResponse = {
    items: result.items,
    hasMore: result.hasMore,
    nextCursor: result.nextCursor,
    serverTime: result.serverTime
  }

  c.header('X-Server-Cursor', String(result.nextCursor))
  console.log(`${LOG_PREFIX} GET /sync/changes response`, {
    itemCount: result.items.length,
    hasMore: result.hasMore,
    nextCursor: result.nextCursor
  })
  return c.json(response)
})

// =============================================================================
// T085: POST /sync/push
// =============================================================================

syncRoutes.post('/push', async (c) => {
  const auth = getAuth(c)

  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    throw badRequest('Invalid JSON in request body')
  }
  const parsed = PushSyncRequestSchema.safeParse(body)

  if (!parsed.success) {
    throw validationError('Invalid request body', { issues: parsed.error.issues })
  }

  const { items } = parsed.data

  if (items.length === 0) {
    throw badRequest('No items to push')
  }

  if (items.length > 100) {
    throw badRequest('Maximum 100 items per push')
  }

  console.log(`${LOG_PREFIX} POST /sync/push`, { itemCount: items.length })
  const result = await pushSyncItems(c.env.DB, auth.userId, items)
  await updateDeviceLastSyncAt(c.env.DB, auth.deviceId)

  if (result.accepted.length > 0) {
    const doId = c.env.USER_SYNC_STATE.idFromName(auth.userId)
    const stub = c.env.USER_SYNC_STATE.get(doId)

    c.executionCtx.waitUntil(
      stub.fetch(
        new Request(DO_BROADCAST_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'changes',
            cursor: result.serverCursor,
            count: result.accepted.length,
            excludeDeviceId: auth.deviceId
          })
        })
      )
    )
  }

  const response: PushSyncResponse = {
    accepted: result.accepted,
    rejected: result.rejected,
    conflicts: result.conflicts,
    serverCursor: result.serverCursor
  }

  c.header('X-Server-Cursor', String(result.serverCursor))
  console.log(`${LOG_PREFIX} POST /sync/push response`, {
    accepted: result.accepted.length,
    rejected: result.rejected.length,
    conflicts: result.conflicts.length,
    serverCursor: result.serverCursor
  })
  if (result.rejected.length > 0) {
    console.warn(`${LOG_PREFIX} POST /sync/push rejected items`, result.rejected)
  }
  return c.json(response)
})

// =============================================================================
// T086: POST /sync/pull
// =============================================================================

syncRoutes.post('/pull', async (c) => {
  const auth = getAuth(c)

  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    throw badRequest('Invalid JSON in request body')
  }
  const parsed = PullRequestSchema.safeParse(body)

  if (!parsed.success) {
    throw validationError('Invalid request body', { issues: parsed.error.issues })
  }

  const { itemIds } = parsed.data

  if (itemIds.length === 0) {
    return c.json({ items: [] })
  }

  console.log(`${LOG_PREFIX} POST /sync/pull`, { itemCount: itemIds.length })
  const items = await getSyncItems(c.env.DB, auth.userId, itemIds)

  console.log(`${LOG_PREFIX} POST /sync/pull response`, { itemCount: items.length })
  return c.json({ items })
})

// =============================================================================
// T087: GET /sync/items/:id
// =============================================================================

syncRoutes.get('/items/:id', async (c) => {
  const auth = getAuth(c)
  const itemId = c.req.param('id')

  if (!itemId || !isValidSyncItemId(itemId)) {
    throw badRequest('Invalid item ID')
  }

  const item = await getSyncItem(c.env.DB, auth.userId, itemId)

  if (!item) {
    throw notFound('Sync item')
  }

  return c.json(item)
})

// =============================================================================
// T088: DELETE /sync/items/:id
// =============================================================================

syncRoutes.delete('/items/:id', async (c) => {
  const auth = getAuth(c)
  const itemId = c.req.param('id')

  if (!itemId || !isValidSyncItemId(itemId)) {
    throw badRequest('Invalid item ID')
  }

  const deletedItem = await softDeleteSyncItem(c.env.DB, auth.userId, itemId)

  if (!deletedItem) {
    throw notFound('Sync item')
  }

  return c.body(null, 204)
})

// =============================================================================
// Helper Functions
// =============================================================================

function isValidSyncItemId(str: string): boolean {
  return str.length > 0 && str.length <= 128
}

export { syncRoutes }
