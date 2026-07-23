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

/**
 * Spatial-canvas sync payload. Every field is optional on purpose (repo
 * forward-tolerance convention): a payload written by a newer client must
 * still parse on an older one, so a missing/renamed field degrades to `skip`
 * rather than a whole-page parse failure that advances the cursor past good
 * data. Presence of `scene` (the serialized Excalidraw snapshot) is therefore
 * validated at the apply/push USE site, never here. `deletedAt` is
 * push-metadata only — tombstones are routed to the delete path by the pull
 * coordinator (`dec.deletedAt ? 'delete'`), not by this field.
 */
export const CanvasSyncPayloadSchema = z.object({
  id: z.string().optional(),
  vaultId: z.string().optional(),
  title: z.string().nullable().optional(),
  scene: z.string().optional(),
  clock: VectorClockSchema.optional(),
  deletedAt: z.number().nullable().optional()
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

export const ProjectLinkSyncSchema = z.object({
  id: z.string(),
  projectId: z.string().optional(),
  itemType: z.string(),
  itemId: z.string(),
  position: z.number(),
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
  statuses: z.array(StatusSyncSchema).optional(),
  homeNoteId: z.string().nullable().optional(),
  links: z.array(ProjectLinkSyncSchema).optional()
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
  attachmentReferences: z.array(z.string()).nullable().optional(),
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
  icon: z.string().nullable().optional(),
  clock: VectorClockSchema.optional(),
  createdAt: z.string().optional()
})

export const FolderConfigSyncPayloadSchema = z.object({
  icon: z.string().nullable(),
  clock: VectorClockSchema.optional(),
  createdAt: z.string().optional(),
  modifiedAt: z.string().optional()
})

export const CalendarEventSyncPayloadSchema = z.object({
  title: z.string().optional(),
  description: z.string().nullable().optional(),
  location: z.string().nullable().optional(),
  startAt: z.string().optional(),
  endAt: z.string().nullable().optional(),
  timezone: z.string().optional(),
  isAllDay: z.boolean().optional(),
  recurrenceRule: z.record(z.string(), z.unknown()).nullable().optional(),
  recurrenceExceptions: z.array(z.string()).nullable().optional(),
  attendees: z.array(z.record(z.string(), z.unknown())).nullable().optional(),
  reminders: z.record(z.string(), z.unknown()).nullable().optional(),
  visibility: z.enum(['default', 'public', 'private', 'confidential']).nullable().optional(),
  colorId: z.string().nullable().optional(),
  conferenceData: z.record(z.string(), z.unknown()).nullable().optional(),
  archivedAt: z.string().nullable().optional(),
  clock: VectorClockSchema.optional(),
  fieldClocks: FieldClocksSchema.nullable().optional(),
  createdAt: z.string().optional(),
  modifiedAt: z.string().optional()
})

export const CalendarSourceSyncPayloadSchema = z.object({
  provider: z.string().optional(),
  kind: z.enum(['account', 'calendar']).optional(),
  accountId: z.string().nullable().optional(),
  remoteId: z.string().optional(),
  title: z.string().optional(),
  timezone: z.string().nullable().optional(),
  color: z.string().nullable().optional(),
  isPrimary: z.boolean().optional(),
  isSelected: z.boolean().optional(),
  isMemryManaged: z.boolean().optional(),
  syncCursor: z.string().nullable().optional(),
  syncStatus: z.enum(['idle', 'ok', 'error', 'pending']).optional(),
  lastSyncedAt: z.string().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
  archivedAt: z.string().nullable().optional(),
  clock: VectorClockSchema.optional(),
  createdAt: z.string().optional(),
  modifiedAt: z.string().optional()
})

export const CalendarBindingSyncPayloadSchema = z.object({
  sourceType: z.enum(['event', 'task', 'reminder', 'inbox_snooze']).optional(),
  sourceId: z.string().optional(),
  provider: z.string().optional(),
  remoteCalendarId: z.string().optional(),
  remoteEventId: z.string().optional(),
  ownershipMode: z.enum(['memry_managed', 'provider_managed']).optional(),
  writebackMode: z.enum(['schedule_only', 'time_and_text', 'broad']).optional(),
  remoteVersion: z.string().nullable().optional(),
  lastLocalSnapshot: z.record(z.string(), z.unknown()).nullable().optional(),
  archivedAt: z.string().nullable().optional(),
  clock: VectorClockSchema.optional(),
  createdAt: z.string().optional(),
  modifiedAt: z.string().optional()
})

export const CalendarExternalEventSyncPayloadSchema = z.object({
  sourceId: z.string().optional(),
  remoteEventId: z.string().optional(),
  remoteEtag: z.string().nullable().optional(),
  remoteUpdatedAt: z.string().nullable().optional(),
  title: z.string().optional(),
  description: z.string().nullable().optional(),
  location: z.string().nullable().optional(),
  startAt: z.string().optional(),
  endAt: z.string().nullable().optional(),
  timezone: z.string().nullable().optional(),
  isAllDay: z.boolean().optional(),
  status: z.enum(['confirmed', 'tentative', 'cancelled']).optional(),
  recurrenceRule: z.record(z.string(), z.unknown()).nullable().optional(),
  attendees: z.array(z.record(z.string(), z.unknown())).nullable().optional(),
  reminders: z.record(z.string(), z.unknown()).nullable().optional(),
  visibility: z.enum(['default', 'public', 'private', 'confidential']).nullable().optional(),
  colorId: z.string().nullable().optional(),
  conferenceData: z.record(z.string(), z.unknown()).nullable().optional(),
  rawPayload: z.record(z.string(), z.unknown()).nullable().optional(),
  archivedAt: z.string().nullable().optional(),
  clock: VectorClockSchema.optional(),
  createdAt: z.string().optional(),
  modifiedAt: z.string().optional()
})

const AgentMessageContentSchema = z.discriminatedUnion('role', [
  z.object({ role: z.literal('user'), data: z.object({ text: z.string() }) }),
  z.object({ role: z.literal('assistant'), data: z.object({ text: z.string() }) }),
  z.object({
    role: z.literal('tool_call'),
    data: z.object({
      tool: z.string(),
      args: z.record(z.string(), z.unknown()),
      status: z.enum([
        'pending',
        'approved',
        'denied',
        'completed',
        'failed',
        'input-streaming',
        'approval-requested',
        'approval-responded',
        'input-available',
        'output-available',
        'output-error',
        'output-denied'
      ]),
      approvedArgs: z.record(z.string(), z.unknown()).optional(),
      output: z.unknown().optional(),
      error: z.object({ code: z.string(), message: z.string() }).optional()
    })
  }),
  z.object({
    role: z.literal('tool_result'),
    data: z.object({
      ok: z.boolean(),
      data: z.unknown().optional(),
      error: z.object({ code: z.string(), message: z.string() }).optional()
    })
  }),
  z.object({
    role: z.literal('system'),
    data: z.object({
      kind: z.enum(['context_attached', 'compacted', 'backend_changed']),
      payload: z.record(z.string(), z.unknown())
    })
  })
])

const AgentAttachmentSnapshotSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('inline_note'),
    title: z.string(),
    contentMarkdown: z.string(),
    truncated: z.boolean()
  }),
  z.object({
    mode: z.literal('inline_journal'),
    date: z.string(),
    contentMarkdown: z.string(),
    truncated: z.boolean()
  }),
  z.object({
    mode: z.literal('inline_task'),
    title: z.string(),
    status: z.string(),
    due: z.string().optional(),
    project: z.string().optional(),
    notes: z.string().optional()
  }),
  z.object({
    mode: z.literal('inline_project'),
    name: z.string(),
    status: z.string().optional(),
    taskCount: z.number().optional()
  }),
  z.object({
    mode: z.literal('reference_only'),
    path: z.string().optional(),
    id: z.string().optional()
  })
])

const AgentMessageAttachmentSchema = z.object({
  kind: z.enum([
    'note',
    'folder',
    'task',
    'project',
    'journal',
    'current_note',
    'inbox',
    'calendar_event'
  ]),
  refId: z.string(),
  label: z.string(),
  snapshotAt: z.number(),
  snapshot: AgentAttachmentSnapshotSchema
})

export const AgentConversationSyncPayloadSchema = z.object({
  vaultId: z.string(),
  title: z.string(),
  backend: z.string(),
  backendModel: z.string().nullable(),
  trustList: z.array(z.string()),
  pinned: z.boolean(),
  clock: VectorClockSchema.optional(),
  fieldClocks: FieldClocksSchema,
  createdAt: z.number().int().min(0),
  updatedAt: z.number().int().min(0),
  deletedAt: z.number().int().min(0).nullable().optional()
})

export const AgentMessageSyncPayloadSchema = z.object({
  conversationId: z.string(),
  role: z.enum(['user', 'assistant', 'tool_call', 'tool_result', 'system']),
  content: AgentMessageContentSchema,
  attachments: z.array(AgentMessageAttachmentSchema),
  toolCallId: z.string().nullable(),
  status: z.enum(['completed', 'cancelled', 'error']),
  clock: VectorClockSchema.optional(),
  createdAt: z.number().int().min(0),
  updatedAt: z.number().int().min(0),
  deletedAt: z.number().int().min(0).nullable().optional()
})

export type FolderConfigSyncPayload = z.infer<typeof FolderConfigSyncPayloadSchema>
export type CalendarEventSyncPayload = z.infer<typeof CalendarEventSyncPayloadSchema>
export type CalendarSourceSyncPayload = z.infer<typeof CalendarSourceSyncPayloadSchema>
export type CalendarBindingSyncPayload = z.infer<typeof CalendarBindingSyncPayloadSchema>
export type CalendarExternalEventSyncPayload = z.infer<
  typeof CalendarExternalEventSyncPayloadSchema
>

export type TaskSyncPayload = z.infer<typeof TaskSyncPayloadSchema>
export type InboxSyncPayload = z.infer<typeof InboxSyncPayloadSchema>
export type FilterSyncPayload = z.infer<typeof FilterSyncPayloadSchema>
export type CanvasSyncPayload = z.infer<typeof CanvasSyncPayloadSchema>
export type ProjectSyncPayload = z.infer<typeof ProjectSyncPayloadSchema>
export type StatusSync = z.infer<typeof StatusSyncSchema>
export type ProjectLinkSync = z.infer<typeof ProjectLinkSyncSchema>
export type NoteSyncPayload = z.infer<typeof NoteSyncPayloadSchema>
export type JournalSyncPayload = z.infer<typeof JournalSyncPayloadSchema>
export type TagDefinitionSyncPayload = z.infer<typeof TagDefinitionSyncPayloadSchema>
export type AgentConversationSyncPayload = z.infer<typeof AgentConversationSyncPayloadSchema>
export type AgentMessageSyncPayload = z.infer<typeof AgentMessageSyncPayloadSchema>
