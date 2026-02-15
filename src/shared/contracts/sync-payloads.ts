import { z } from 'zod'
import { VectorClockSchema } from './sync-api'

export const TaskSyncPayloadSchema = z.object({
  title: z.string().optional(),
  description: z.string().nullable().optional(),
  projectId: z.string().optional(),
  statusId: z.string().nullable().optional(),
  parentId: z.string().nullable().optional(),
  priority: z.number().optional(),
  position: z.number().optional(),
  dueDate: z.string().nullable().optional(),
  dueTime: z.string().nullable().optional(),
  startDate: z.string().nullable().optional(),
  repeatConfig: z.unknown().nullable().optional(),
  repeatFrom: z.string().nullable().optional(),
  sourceNoteId: z.string().nullable().optional(),
  completedAt: z.string().nullable().optional(),
  archivedAt: z.string().nullable().optional(),
  clock: VectorClockSchema.optional(),
  createdAt: z.string().optional(),
  modifiedAt: z.string().optional()
})

export const InboxSyncPayloadSchema = z.object({
  title: z.string().optional(),
  content: z.string().nullable().optional(),
  type: z.string().optional(),
  metadata: z.unknown().nullable().optional(),
  filedAt: z.string().nullable().optional(),
  filedTo: z.string().nullable().optional(),
  filedAction: z.string().nullable().optional(),
  snoozedUntil: z.string().nullable().optional(),
  snoozeReason: z.string().nullable().optional(),
  archivedAt: z.string().nullable().optional(),
  sourceUrl: z.string().nullable().optional(),
  sourceTitle: z.string().nullable().optional(),
  clock: VectorClockSchema.optional(),
  createdAt: z.string().optional(),
  modifiedAt: z.string().optional()
})

export const FilterSyncPayloadSchema = z.object({
  name: z.string().optional(),
  config: z.unknown().optional(),
  position: z.number().optional(),
  clock: VectorClockSchema.optional(),
  createdAt: z.string().optional()
})

export type TaskSyncPayload = z.infer<typeof TaskSyncPayloadSchema>
export type InboxSyncPayload = z.infer<typeof InboxSyncPayloadSchema>
export type FilterSyncPayload = z.infer<typeof FilterSyncPayloadSchema>
