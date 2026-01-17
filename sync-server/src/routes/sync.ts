/**
 * Sync Routes
 *
 * Handles sync endpoints for push/pull operations:
 * - GET /sync/status - Current sync status
 * - GET /sync/manifest - All items metadata
 * - GET /sync/changes - Changes since timestamp
 * - POST /sync/push - Push local changes
 * - POST /sync/pull - Request items
 * - GET /sync/items/:id - Get single item
 * - DELETE /sync/items/:id - Delete item
 *
 * Rate Limits (from contracts):
 * - Push: 100 req/min, burst 20
 * - Pull: 200 req/min
 * - Manifest: 10 req/min
 *
 * @module routes/sync
 */

import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import type { Env } from '../index'
import { authMiddleware, type AuthContext } from '../middleware/auth'
import { createSyncService, type SyncItemType, type SyncOperation, type VectorClock } from '../services/sync'
import { NotFoundError, ValidationError } from '../lib/errors'

// =============================================================================
// Zod Schemas
// =============================================================================

const syncItemTypeSchema = z.enum(['note', 'task', 'project', 'settings', 'attachment', 'inbox_item', 'saved_filter'])

const syncOperationSchema = z.enum(['create', 'update', 'delete'])

const vectorClockSchema = z.record(z.string(), z.number())

const syncPushItemSchema = z.object({
  id: z.string().min(1),
  type: syncItemTypeSchema,
  operation: syncOperationSchema,
  encryptedData: z.string(),
  signature: z.string(),
  clock: vectorClockSchema.optional(),
  stateVector: z.string().optional(),
})

const syncPushRequestSchema = z.object({
  items: z.array(syncPushItemSchema).min(1).max(100),
  deviceClock: vectorClockSchema,
})

const syncPullRequestSchema = z.object({
  since: z.number().optional(),
  types: z.array(syncItemTypeSchema).optional(),
  limit: z.number().min(1).max(100).optional(),
  deviceClock: vectorClockSchema,
})

const changesQuerySchema = z.object({
  since: z.coerce.number().optional(),
  limit: z.coerce.number().min(1).max(100).optional(),
})

// =============================================================================
// Route Handlers
// =============================================================================

const sync = new Hono<{ Bindings: Env; Variables: { user: AuthContext } }>()

// Apply auth middleware to all sync routes
sync.use('*', authMiddleware)

// -----------------------------------------------------------------------------
// GET /sync/status (T082)
// -----------------------------------------------------------------------------

sync.get('/status', async (c) => {
  const user = c.get('user')
  const syncService = createSyncService(c.env)

  // Get storage usage
  const storageUsed = await syncService.getStorageUsage(user.userId)

  // Get pending changes count (items modified since last known sync)
  const manifest = await syncService.getManifest(user.userId)
  const totalItems = manifest.length
  const deletedItems = manifest.filter((item) => item.deletedAt).length

  return c.json({
    status: 'ok',
    userId: user.userId,
    deviceId: user.deviceId,
    totalItems,
    deletedItems,
    storageUsed,
    serverTimestamp: Date.now(),
  })
})

// -----------------------------------------------------------------------------
// GET /sync/manifest (T083)
// -----------------------------------------------------------------------------

sync.get('/manifest', async (c) => {
  const user = c.get('user')
  const syncService = createSyncService(c.env)

  const items = await syncService.getManifest(user.userId)

  return c.json({
    items,
    count: items.length,
    serverTimestamp: Date.now(),
  })
})

// -----------------------------------------------------------------------------
// GET /sync/changes (T084)
// -----------------------------------------------------------------------------

sync.get('/changes', zValidator('query', changesQuerySchema), async (c) => {
  const user = c.get('user')
  const { since, limit } = c.req.valid('query')
  const syncService = createSyncService(c.env)

  const { items, hasMore } = await syncService.getChanges(user.userId, since ?? 0, limit ?? 100)

  return c.json({
    items,
    hasMore,
    serverTimestamp: Date.now(),
  })
})

// -----------------------------------------------------------------------------
// POST /sync/push (T085)
// -----------------------------------------------------------------------------

sync.post('/push', zValidator('json', syncPushRequestSchema), async (c) => {
  const user = c.get('user')
  const { items, deviceClock } = c.req.valid('json')
  const syncService = createSyncService(c.env)

  // Validate items
  if (items.length === 0) {
    throw new ValidationError('No items to push')
  }

  // Push items
  const result = await syncService.pushItems(
    user.userId,
    items.map((item) => ({
      ...item,
      type: item.type as SyncItemType,
      operation: item.operation as SyncOperation,
      clock: item.clock as VectorClock | undefined,
    })),
    deviceClock as VectorClock
  )

  // Update storage usage
  const storageUsed = await syncService.getStorageUsage(user.userId)
  await syncService.updateStorageUsage(user.userId, storageUsed)

  // Notify other devices via Durable Object
  if (result.accepted.length > 0) {
    try {
      const userStateId = c.env.USER_STATE.idFromName(user.userId)
      const userState = c.env.USER_STATE.get(userStateId)

      // Broadcast to other devices
      for (const itemId of result.accepted) {
        const item = items.find((i) => i.id === itemId)
        if (item) {
          await userState.fetch(
            new Request('https://internal/broadcast', {
              method: 'POST',
              body: JSON.stringify({
                type: 'item-synced',
                payload: {
                  itemId: item.id,
                  type: item.type,
                  operation: item.operation,
                  deviceId: user.deviceId,
                  version: 1, // Simplified - would get from DB
                },
                excludeDevice: user.deviceId,
              }),
            })
          )
        }
      }
    } catch (error) {
      // Log but don't fail the request
      console.error('Failed to broadcast sync update:', error)
    }
  }

  return c.json({
    success: true,
    accepted: result.accepted,
    conflicts: result.conflicts,
    serverClock: result.serverClock,
    serverTimestamp: Date.now(),
  })
})

// -----------------------------------------------------------------------------
// POST /sync/pull (T086)
// -----------------------------------------------------------------------------

sync.post('/pull', zValidator('json', syncPullRequestSchema), async (c) => {
  const user = c.get('user')
  const { since, types, limit, deviceClock } = c.req.valid('json')
  const syncService = createSyncService(c.env)

  const result = await syncService.pullItems(
    user.userId,
    since,
    types as SyncItemType[] | undefined,
    limit ?? 100
  )

  return c.json({
    items: result.items,
    hasMore: result.hasMore,
    serverClock: result.serverClock,
    serverTimestamp: result.serverTimestamp,
  })
})

// -----------------------------------------------------------------------------
// GET /sync/items/:id (T087)
// -------------------/----------------------------------------------------------

sync.get('/items/:id', async (c) => {
  const user = c.get('user')
  const itemId = c.req.param('id')
  const syncService = createSyncService(c.env)

  const item = await syncService.getItem(user.userId, itemId)

  if (!item) {
    throw new NotFoundError('Sync item')
  }

  return c.json(item)
})

// -----------------------------------------------------------------------------
// DELETE /sync/items/:id (T088)
// -----------------------------------------------------------------------------

sync.delete('/items/:id', async (c) => {
  const user = c.get('user')
  const itemId = c.req.param('id')
  const syncService = createSyncService(c.env)

  const deleted = await syncService.deleteItem(user.userId, itemId)

  if (!deleted) {
    throw new NotFoundError('Sync item')
  }

  // Notify other devices
  try {
    const userStateId = c.env.USER_STATE.idFromName(user.userId)
    const userState = c.env.USER_STATE.get(userStateId)

    await userState.fetch(
      new Request('https://internal/broadcast', {
        method: 'POST',
        body: JSON.stringify({
          type: 'item-synced',
          payload: {
            itemId,
            type: 'unknown', // We don't have the type here
            operation: 'delete',
            deviceId: user.deviceId,
            version: 0,
          },
          excludeDevice: user.deviceId,
        }),
      })
    )
  } catch (error) {
    console.error('Failed to broadcast delete:', error)
  }

  return c.json({
    success: true,
    id: itemId,
    serverTimestamp: Date.now(),
  })
})

export default sync
