/**
 * CRDT API Contracts (Client-side)
 *
 * Types for CRDT sync endpoints - mirrors server contracts.
 * Used for storing and retrieving encrypted Yjs CRDT updates and snapshots.
 *
 * @module contracts/crdt-api
 */

import { z } from 'zod'

const NoteIdSchema = z.string().min(1).max(128)
const Base64Schema = z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/, 'Invalid Base64 string')

const DeviceIdSchema = z.string().min(1).max(64)

export const CrdtUpdatePushSchema = z.object({
  noteId: NoteIdSchema,
  updateData: Base64Schema,
  signature: Base64Schema,
  signerDeviceId: DeviceIdSchema
})

export type CrdtUpdatePush = z.infer<typeof CrdtUpdatePushSchema>

export const PushCrdtUpdatesResponseSchema = z.object({
  accepted: z.array(
    z.object({
      noteId: NoteIdSchema,
      sequenceNum: z.number().int().positive()
    })
  ),
  rejected: z.array(
    z.object({
      noteId: NoteIdSchema,
      reason: z.string()
    })
  ),
  serverTime: z.number().int().positive()
})

export type PushCrdtUpdatesResponse = z.infer<typeof PushCrdtUpdatesResponseSchema>

export const CrdtUpdateResponseSchema = z.object({
  sequenceNum: z.number().int().positive(),
  updateData: Base64Schema,
  signature: Base64Schema,
  signerDeviceId: DeviceIdSchema,
  createdAt: z.number().int().positive()
})

export type CrdtUpdateResponse = z.infer<typeof CrdtUpdateResponseSchema>

export const GetCrdtUpdatesResponseSchema = z.object({
  noteId: NoteIdSchema,
  updates: z.array(CrdtUpdateResponseSchema),
  hasMore: z.boolean(),
  latestSequence: z.number().int().nonnegative(),
  serverTime: z.number().int().positive()
})

export type GetCrdtUpdatesResponse = z.infer<typeof GetCrdtUpdatesResponseSchema>

export const PushCrdtSnapshotResponseSchema = z.object({
  success: z.boolean(),
  noteId: NoteIdSchema,
  sequenceNum: z.number().int().positive(),
  storageType: z.enum(['d1', 'r2']),
  updatesPruned: z.number().int().nonnegative(),
  serverTime: z.number().int().positive()
})

export type PushCrdtSnapshotResponse = z.infer<typeof PushCrdtSnapshotResponseSchema>

export const GetCrdtSnapshotResponseSchema = z.object({
  noteId: NoteIdSchema,
  snapshotData: Base64Schema.optional(),
  sequenceNum: z.number().int().nonnegative(),
  sizeBytes: z.number().int().nonnegative(),
  createdAt: z.number().int().positive().optional(),
  exists: z.boolean(),
  corrupted: z.boolean().optional()
})

export type GetCrdtSnapshotResponse = z.infer<typeof GetCrdtSnapshotResponseSchema>
