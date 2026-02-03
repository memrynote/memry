/**
 * CRDT Routes
 *
 * Implements CRDT sync endpoints for encrypted Yjs updates and snapshots:
 * - T135: POST /updates - Upload incremental Yjs updates
 * - T136: GET /updates - Fetch updates since sequence
 * - T137: POST /snapshot - Upload full snapshot
 * - T138: GET /snapshot/:noteId - Fetch latest snapshot
 */

import { Hono } from 'hono'
import type { Env } from '../index'
import type { AuthContext } from '../middleware/auth'
import { getAuth } from '../middleware/auth'
import { validationError, badRequest, forbidden } from '../lib/errors'
import {
  storeCrdtUpdates,
  getCrdtUpdates,
  storeCrdtSnapshot,
  getCrdtSnapshot,
  verifyNoteOwnership
} from '../services/crdt'
import {
  PushCrdtUpdatesRequestSchema,
  GetCrdtUpdatesQuerySchema,
  PushCrdtSnapshotRequestSchema,
  GetCrdtSnapshotParamsSchema,
  type PushCrdtUpdatesResponse,
  type GetCrdtUpdatesResponse,
  type PushCrdtSnapshotResponse,
  type GetCrdtSnapshotResponse
} from '../contracts/crdt-api'

interface CrdtVariables {
  auth: AuthContext
}

const LOG_PREFIX = '[CrdtRoutes]'

const crdtRoutes = new Hono<{ Bindings: Env; Variables: CrdtVariables }>()

// =============================================================================
// T135: POST /updates - Upload incremental Yjs updates
// =============================================================================

crdtRoutes.post('/updates', async (c) => {
  const auth = getAuth(c)

  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    throw badRequest('Invalid JSON in request body')
  }

  const parsed = PushCrdtUpdatesRequestSchema.safeParse(body)
  if (!parsed.success) {
    throw validationError('Invalid request body', { issues: parsed.error.issues })
  }

  const { updates } = parsed.data

  console.log(`${LOG_PREFIX} POST /updates`, { userId: auth.userId, count: updates.length })

  const result = await storeCrdtUpdates(c.env.DB, auth.userId, updates)

  if (result.accepted.length > 0) {
    const doId = c.env.USER_SYNC_STATE.idFromName(auth.userId)
    const stub = c.env.USER_SYNC_STATE.get(doId)
    const noteIds = [...new Set(result.accepted.map((u) => u.noteId))]

    c.executionCtx.waitUntil(
      stub.fetch(
        new Request('http://internal/broadcast', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'crdt',
            noteIds,
            excludeDeviceId: auth.deviceId
          })
        })
      )
    )

    console.log(`${LOG_PREFIX} Broadcasting CRDT updates`, {
      noteIds,
      excludeDeviceId: auth.deviceId
    })
  }

  const response: PushCrdtUpdatesResponse = {
    accepted: result.accepted,
    rejected: result.rejected,
    serverTime: Date.now()
  }

  console.log(`${LOG_PREFIX} POST /updates response`, {
    accepted: result.accepted.length,
    rejected: result.rejected.length
  })

  return c.json(response)
})

// =============================================================================
// T136: GET /updates - Fetch updates since sequence
// =============================================================================

crdtRoutes.get('/updates', async (c) => {
  const auth = getAuth(c)

  const parsed = GetCrdtUpdatesQuerySchema.safeParse(c.req.query())
  if (!parsed.success) {
    throw validationError('Invalid query parameters', { issues: parsed.error.issues })
  }

  const { noteId, sinceSequence, limit } = parsed.data

  const ownsNote = await verifyNoteOwnership(c.env.DB, auth.userId, noteId)
  if (!ownsNote) {
    throw forbidden('Note not found or not owned by user')
  }

  console.log(`${LOG_PREFIX} GET /updates`, { noteId, sinceSequence, limit })

  const result = await getCrdtUpdates(c.env.DB, auth.userId, noteId, sinceSequence, limit)

  const response: GetCrdtUpdatesResponse = result

  console.log(`${LOG_PREFIX} GET /updates response`, {
    noteId,
    updateCount: result.updates.length,
    hasMore: result.hasMore,
    latestSequence: result.latestSequence
  })

  return c.json(response)
})

// =============================================================================
// T137: POST /snapshot - Upload full snapshot
// =============================================================================

crdtRoutes.post('/snapshot', async (c) => {
  const auth = getAuth(c)

  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    throw badRequest('Invalid JSON in request body')
  }

  const parsed = PushCrdtSnapshotRequestSchema.safeParse(body)
  if (!parsed.success) {
    throw validationError('Invalid request body', { issues: parsed.error.issues })
  }

  const { noteId, snapshotData, sequenceNum, sizeBytes } = parsed.data

  const ownsNote = await verifyNoteOwnership(c.env.DB, auth.userId, noteId)
  if (!ownsNote) {
    throw forbidden('Note not found or not owned by user')
  }

  console.log(`${LOG_PREFIX} POST /snapshot`, { noteId, sequenceNum, sizeBytes })

  const result = await storeCrdtSnapshot(
    c.env.DB,
    c.env.BUCKET,
    auth.userId,
    noteId,
    snapshotData,
    sequenceNum,
    sizeBytes
  )

  const response: PushCrdtSnapshotResponse = result

  console.log(`${LOG_PREFIX} POST /snapshot response`, {
    noteId,
    sequenceNum: result.sequenceNum,
    storageType: result.storageType,
    updatesPruned: result.updatesPruned
  })

  return c.json(response)
})

// =============================================================================
// T138: GET /snapshot/:noteId - Fetch latest snapshot
// =============================================================================

crdtRoutes.get('/snapshot/:noteId', async (c) => {
  const auth = getAuth(c)
  const noteIdParam = c.req.param('noteId')

  const parsed = GetCrdtSnapshotParamsSchema.safeParse({ noteId: noteIdParam })
  if (!parsed.success) {
    throw validationError('Invalid note ID', { issues: parsed.error.issues })
  }

  const { noteId } = parsed.data

  const ownsNote = await verifyNoteOwnership(c.env.DB, auth.userId, noteId)
  if (!ownsNote) {
    throw forbidden('Note not found or not owned by user')
  }

  console.log(`${LOG_PREFIX} GET /snapshot/:noteId`, { noteId })

  const result = await getCrdtSnapshot(c.env.DB, c.env.BUCKET, auth.userId, noteId)

  const response: GetCrdtSnapshotResponse = result

  console.log(`${LOG_PREFIX} GET /snapshot/:noteId response`, {
    noteId,
    exists: result.exists,
    sequenceNum: result.sequenceNum,
    sizeBytes: result.sizeBytes
  })

  return c.json(response)
})

export { crdtRoutes }
