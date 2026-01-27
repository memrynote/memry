/**
 * CRDT API Contracts
 *
 * Defines all types and schemas for CRDT sync endpoints.
 * Used for storing and retrieving encrypted Yjs CRDT updates and snapshots.
 *
 * @module contracts/crdt-api
 */

import { z } from 'zod'

const UuidSchema = z.string().uuid()
const Base64Schema = z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/, 'Invalid Base64 string')

const MAX_SNAPSHOT_BASE64_SIZE = 10 * 1024 * 1024

// =============================================================================
// Push CRDT Updates (T135)
// =============================================================================

export const CrdtUpdateSchema = z.object({
  noteId: UuidSchema,
  updateData: Base64Schema,
  sequenceNum: z.number().int().positive()
})

export type CrdtUpdate = z.infer<typeof CrdtUpdateSchema>

export const PushCrdtUpdatesRequestSchema = z.object({
  updates: z.array(CrdtUpdateSchema).min(1).max(100)
})

export type PushCrdtUpdatesRequest = z.infer<typeof PushCrdtUpdatesRequestSchema>

export const PushCrdtUpdatesResponseSchema = z.object({
  accepted: z.array(
    z.object({
      noteId: UuidSchema,
      sequenceNum: z.number().int().positive()
    })
  ),
  rejected: z.array(
    z.object({
      noteId: UuidSchema,
      sequenceNum: z.number().int().positive(),
      reason: z.string()
    })
  ),
  serverTime: z.number().int().positive()
})

export type PushCrdtUpdatesResponse = z.infer<typeof PushCrdtUpdatesResponseSchema>

// =============================================================================
// Get CRDT Updates (T136)
// =============================================================================

export const GetCrdtUpdatesQuerySchema = z.object({
  noteId: UuidSchema,
  sinceSequence: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce.number().int().positive().max(100).default(50)
})

export type GetCrdtUpdatesQuery = z.infer<typeof GetCrdtUpdatesQuerySchema>

export const CrdtUpdateResponseSchema = z.object({
  sequenceNum: z.number().int().positive(),
  updateData: Base64Schema,
  createdAt: z.number().int().positive()
})

export type CrdtUpdateResponse = z.infer<typeof CrdtUpdateResponseSchema>

export const GetCrdtUpdatesResponseSchema = z.object({
  noteId: UuidSchema,
  updates: z.array(CrdtUpdateResponseSchema),
  hasMore: z.boolean(),
  latestSequence: z.number().int().nonnegative(),
  serverTime: z.number().int().positive()
})

export type GetCrdtUpdatesResponse = z.infer<typeof GetCrdtUpdatesResponseSchema>

// =============================================================================
// Push CRDT Snapshot (T137)
// =============================================================================

export const PushCrdtSnapshotRequestSchema = z.object({
  noteId: UuidSchema,
  snapshotData: Base64Schema.max(MAX_SNAPSHOT_BASE64_SIZE, 'Snapshot data exceeds 10MB limit'),
  sequenceNum: z.number().int().positive(),
  sizeBytes: z.number().int().positive()
})

export type PushCrdtSnapshotRequest = z.infer<typeof PushCrdtSnapshotRequestSchema>

export const PushCrdtSnapshotResponseSchema = z.object({
  success: z.boolean(),
  noteId: UuidSchema,
  sequenceNum: z.number().int().positive(),
  storageType: z.enum(['d1', 'r2']),
  updatesPruned: z.number().int().nonnegative(),
  serverTime: z.number().int().positive()
})

export type PushCrdtSnapshotResponse = z.infer<typeof PushCrdtSnapshotResponseSchema>

// =============================================================================
// Get CRDT Snapshot (T138)
// =============================================================================

export const GetCrdtSnapshotParamsSchema = z.object({
  noteId: UuidSchema
})

export type GetCrdtSnapshotParams = z.infer<typeof GetCrdtSnapshotParamsSchema>

export const GetCrdtSnapshotResponseSchema = z.object({
  noteId: UuidSchema,
  snapshotData: Base64Schema.optional(),
  sequenceNum: z.number().int().nonnegative(),
  sizeBytes: z.number().int().nonnegative(),
  createdAt: z.number().int().positive().optional(),
  exists: z.boolean(),
  corrupted: z.boolean().optional()
})

export type GetCrdtSnapshotResponse = z.infer<typeof GetCrdtSnapshotResponseSchema>
