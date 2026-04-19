import { z } from 'zod'
import { CalendarChannels } from './ipc-channels.ts'

export { CalendarChannels }

const JsonRecordSchema = z.record(z.string(), z.unknown())

export const CalendarSourceKindSchema = z.enum(['account', 'calendar'])
export const CalendarSourceSyncStatusSchema = z.enum(['idle', 'ok', 'error', 'pending'])
export const CalendarProjectionSourceTypeSchema = z.enum([
  'event',
  'task',
  'reminder',
  'inbox_snooze',
  'external_event'
])
export const CalendarProjectionVisualTypeSchema = z.enum([
  'event',
  'task',
  'reminder',
  'snooze',
  'external_event'
])
export const CalendarChangeEntityTypeSchema = z.enum([
  'calendar_event',
  'calendar_source',
  'calendar_binding',
  'calendar_external_event',
  'projection'
])

export const CreateCalendarEventSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(5000).optional().nullable(),
  location: z.string().max(500).optional().nullable(),
  startAt: z.string().datetime(),
  endAt: z.string().datetime().optional().nullable(),
  timezone: z.string().min(1).default('UTC'),
  isAllDay: z.boolean().default(false),
  recurrenceRule: JsonRecordSchema.optional().nullable(),
  recurrenceExceptions: z.array(z.string()).optional().nullable(),
  targetCalendarId: z.string().nullable().optional()
})

export const UpdateCalendarEventSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(5000).optional().nullable(),
  location: z.string().max(500).optional().nullable(),
  startAt: z.string().datetime().optional(),
  endAt: z.string().datetime().optional().nullable(),
  timezone: z.string().min(1).optional(),
  isAllDay: z.boolean().optional(),
  recurrenceRule: JsonRecordSchema.optional().nullable(),
  recurrenceExceptions: z.array(z.string()).optional().nullable(),
  targetCalendarId: z.string().nullable().optional()
})

export const PromoteExternalEventSchema = z.object({
  externalEventId: z.string().min(1)
})

export const ListGoogleCalendarsSchema = z.object({}).optional().default({})

export const SetDefaultGoogleCalendarSchema = z.object({
  calendarId: z.string().nullable(),
  markOnboardingComplete: z.boolean().default(true)
})

export const ListCalendarEventsSchema = z.object({
  includeArchived: z.boolean().default(false)
})

export const GetCalendarRangeSchema = z.object({
  startAt: z.string().datetime(),
  endAt: z.string().datetime(),
  includeUnselectedSources: z.boolean().default(false)
})

export const ListCalendarSourcesSchema = z.object({
  provider: z.string().min(1).optional(),
  kind: CalendarSourceKindSchema.optional(),
  selectedOnly: z.boolean().optional()
})

export const UpdateCalendarSourceSelectionSchema = z.object({
  id: z.string().min(1),
  isSelected: z.boolean()
})

export const CalendarProviderRequestSchema = z.object({
  provider: z.string().min(1),
  accountId: z.string().min(1).optional()
})

export const RetryCalendarSourceSyncSchema = z.object({
  sourceId: z.string().min(1)
})

export type RetryCalendarSourceSyncInput = z.infer<typeof RetryCalendarSourceSyncSchema>

export interface RetryCalendarSourceSyncResponse {
  success: boolean
  source: CalendarSourceRecord | null
  error?: string
}

export type CalendarSourceKind = z.infer<typeof CalendarSourceKindSchema>
export type CalendarSourceSyncStatus = z.infer<typeof CalendarSourceSyncStatusSchema>
export type CalendarProjectionSourceType = z.infer<typeof CalendarProjectionSourceTypeSchema>
export type CalendarProjectionVisualType = z.infer<typeof CalendarProjectionVisualTypeSchema>
export type CalendarChangeEntityType = z.infer<typeof CalendarChangeEntityTypeSchema>

export type CreateCalendarEventInput = z.infer<typeof CreateCalendarEventSchema>
export type UpdateCalendarEventInput = z.infer<typeof UpdateCalendarEventSchema>
export type ListCalendarEventsInput = z.infer<typeof ListCalendarEventsSchema>
export type GetCalendarRangeInput = z.infer<typeof GetCalendarRangeSchema>
export type ListCalendarSourcesInput = z.infer<typeof ListCalendarSourcesSchema>
export type UpdateCalendarSourceSelectionInput = z.infer<typeof UpdateCalendarSourceSelectionSchema>
export type CalendarProviderRequest = z.infer<typeof CalendarProviderRequestSchema>
export type PromoteExternalEventInput = z.infer<typeof PromoteExternalEventSchema>
export type ListGoogleCalendarsInput = z.infer<typeof ListGoogleCalendarsSchema>
export type SetDefaultGoogleCalendarInput = z.infer<typeof SetDefaultGoogleCalendarSchema>

export interface CalendarEventAttendeeRecord {
  email: string
  displayName?: string | null
  responseStatus?: 'needsAction' | 'declined' | 'tentative' | 'accepted' | null
  optional?: boolean | null
  organizer?: boolean | null
  self?: boolean | null
}

export interface CalendarEventRemindersRecord {
  useDefault: boolean
  overrides: Array<{ method: 'email' | 'popup'; minutes: number }>
}

export interface CalendarEventConferenceDataRecord {
  conferenceId?: string | null
  entryPoints?: Array<{
    entryPointType: string
    uri?: string | null
    label?: string | null
    pin?: string | null
    meetingCode?: string | null
    passcode?: string | null
    regionCode?: string | null
  }>
  notes?: string | null
  conferenceSolution?: {
    key?: { type?: string | null } | null
    name?: string | null
    iconUri?: string | null
  } | null
}

export type CalendarEventVisibility = 'default' | 'public' | 'private' | 'confidential'

export interface CalendarEventRecord {
  id: string
  title: string
  description: string | null
  location: string | null
  startAt: string
  endAt: string | null
  timezone: string
  isAllDay: boolean
  recurrenceRule: Record<string, unknown> | null
  recurrenceExceptions: string[] | null
  attendees: CalendarEventAttendeeRecord[] | null
  reminders: CalendarEventRemindersRecord | null
  visibility: CalendarEventVisibility | null
  colorId: string | null
  conferenceData: CalendarEventConferenceDataRecord | null
  parentEventId: string | null
  originalStartTime: string | null
  targetCalendarId: string | null
  archivedAt: string | null
  syncedAt: string | null
  createdAt: string
  modifiedAt: string
}

export interface CalendarSourceRecord {
  id: string
  provider: string
  kind: CalendarSourceKind
  accountId: string | null
  remoteId: string
  title: string
  timezone: string | null
  color: string | null
  isPrimary: boolean
  isSelected: boolean
  isMemryManaged: boolean
  syncCursor: string | null
  syncStatus: CalendarSourceSyncStatus
  lastSyncedAt: string | null
  lastError: string | null
  metadata: Record<string, unknown> | null
  archivedAt: string | null
  syncedAt: string | null
  createdAt: string
  modifiedAt: string
}

export interface CalendarProjectionEditability {
  canMove: boolean
  canResize: boolean
  canEditText: boolean
  canDelete: boolean
}

export interface CalendarProjectionBinding {
  provider: string
  remoteCalendarId: string
  remoteEventId: string
  ownershipMode: string
  writebackMode: string
}

export interface CalendarProjectionSourceMeta {
  provider: string | null
  calendarSourceId: string | null
  title: string | null
  color: string | null
  kind: CalendarSourceKind | null
  isMemryManaged: boolean
}

export interface CalendarProjectionItem {
  projectionId: string
  sourceType: CalendarProjectionSourceType
  sourceId: string
  title: string
  descriptionPreview: string | null
  startAt: string
  endAt: string | null
  isAllDay: boolean
  timezone: string
  visualType: CalendarProjectionVisualType
  editability: CalendarProjectionEditability
  source: CalendarProjectionSourceMeta
  binding: CalendarProjectionBinding | null
}

export type CalendarProviderAccountConnectionStatus =
  | 'connected'
  | 'disconnected'
  | 'reconnect_required'
  | 'error'

export interface CalendarProviderAccountStatus {
  accountId: string
  email: string
  status: CalendarProviderAccountConnectionStatus
  lastSyncedAt: string | null
  lastError: string | null
}

export interface CalendarProviderStatus {
  provider: string
  connected: boolean
  hasLocalAuth: boolean
  account: Pick<CalendarSourceRecord, 'id' | 'title'> | null
  accounts: CalendarProviderAccountStatus[]
  calendars: {
    total: number
    selected: number
    memryManaged: number
  }
  lastSyncedAt: string | null
}

export interface CalendarChangedEvent {
  entityType: CalendarChangeEntityType
  id: string
}

export interface CalendarEventMutationResponse {
  success: boolean
  event: CalendarEventRecord | null
  error?: string
}

export interface CalendarDeleteResponse {
  success: boolean
  error?: string
}

export interface CalendarEventListResponse {
  events: CalendarEventRecord[]
}

export interface CalendarRangeResponse {
  items: CalendarProjectionItem[]
}

export interface CalendarSourceListResponse {
  sources: CalendarSourceRecord[]
}

export interface CalendarSourceMutationResponse {
  success: boolean
  source: CalendarSourceRecord | null
  error?: string
}

export interface CalendarProviderMutationResponse {
  success: boolean
  status: CalendarProviderStatus
  error?: string
}

// ============================================================================
// M2: Calendar targeting + editable externals
// ============================================================================

export interface GoogleCalendarDescriptorRecord {
  id: string
  title: string
  timezone: string | null
  color: string | null
  isPrimary: boolean
}

export interface ListGoogleCalendarsResponse {
  calendars: GoogleCalendarDescriptorRecord[]
  primary: GoogleCalendarDescriptorRecord | null
  currentDefaultId: string | null
}

export interface PromoteExternalEventResponse {
  success: boolean
  eventId: string | null
  error?: string
}

export interface SetDefaultGoogleCalendarResponse {
  success: boolean
  error?: string
}
