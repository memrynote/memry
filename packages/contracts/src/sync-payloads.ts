import { z } from 'zod'
import { FieldClocksSchema, VectorClockSchema } from './sync-api'

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
  tags: z.array(z.string()).optional(),
  linkedNoteIds: z.array(z.string()).optional(),
  clock: VectorClockSchema.optional(),
  fieldClocks: FieldClocksSchema.optional(),
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
  captureSource: z.string().nullable().optional(),
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

export const StatusSyncSchema = z.object({
  id: z.string(),
  name: z.string(),
  color: z.string(),
  position: z.number(),
  isDefault: z.boolean().optional(),
  isDone: z.boolean().optional(),
  createdAt: z.string().optional()
})

export const ProjectSyncPayloadSchema = z.object({
  name: z.string().optional(),
  description: z.string().nullable().optional(),
  color: z.string().optional(),
  icon: z.string().nullable().optional(),
  position: z.number().optional(),
  isInbox: z.boolean().optional(),
  archivedAt: z.string().nullable().optional(),
  clock: VectorClockSchema.optional(),
  fieldClocks: FieldClocksSchema.optional(),
  createdAt: z.string().optional(),
  modifiedAt: z.string().optional(),
  statuses: z.array(StatusSyncSchema).optional()
})

export const NoteSyncPayloadSchema = z.object({
  title: z.string().optional(),
  content: z.string().nullable().optional(),
  tags: z.array(z.string()).optional(),
  pinnedTags: z.array(z.string()).optional(),
  emoji: z.string().nullable().optional(),
  properties: z.record(z.string(), z.unknown()).nullable().optional(),
  aliases: z.array(z.string()).nullable().optional(),
  fileType: z.enum(['markdown', 'pdf', 'image', 'audio', 'video']).optional(),
  mimeType: z.string().nullable().optional(),
  attachmentId: z.string().nullable().optional(),
  folderPath: z.string().nullable().optional(),
  clock: VectorClockSchema.optional(),
  createdAt: z.string().optional(),
  modifiedAt: z.string().optional()
})

export const JournalSyncPayloadSchema = z.object({
  date: z.string(),
  content: z.string().nullable().optional(),
  tags: z.array(z.string()).optional(),
  properties: z.record(z.string(), z.unknown()).nullable().optional(),
  clock: VectorClockSchema.optional(),
  createdAt: z.string().optional(),
  modifiedAt: z.string().optional()
})

export const TagDefinitionSyncPayloadSchema = z.object({
  name: z.string(),
  color: z.string(),
  clock: VectorClockSchema.optional(),
  createdAt: z.string().optional()
})

export type TaskSyncPayload = z.infer<typeof TaskSyncPayloadSchema>
export type InboxSyncPayload = z.infer<typeof InboxSyncPayloadSchema>
export type FilterSyncPayload = z.infer<typeof FilterSyncPayloadSchema>
export type ProjectSyncPayload = z.infer<typeof ProjectSyncPayloadSchema>
export type StatusSync = z.infer<typeof StatusSyncSchema>
export type NoteSyncPayload = z.infer<typeof NoteSyncPayloadSchema>
export type JournalSyncPayload = z.infer<typeof JournalSyncPayloadSchema>
export type TagDefinitionSyncPayload = z.infer<typeof TagDefinitionSyncPayloadSchema>
