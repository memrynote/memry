import { z } from 'zod'
import { CalendarChannels } from './ipc-channels.ts'
import { CalendarEventColorSchema, type CalendarEventColor } from './calendar-colors.ts'

export { CalendarChannels }

const JsonRecordSchema = z.record(z.string(), z.unknown())

export const CalendarSourceKindSchema = z.enum(['account', 'calendar'])
export const CalendarSourceSyncStatusSchema = z.enum(['idle', 'ok', 'error', 'pending'])
export const CalendarProjectionSourceTypeSchema = z.enum([
  'event',
  'task',
  'reminder',
  'inbox_snooze',
  'external_event',
  'note',
  'note_date'
])
export const CalendarProjectionVisualTypeSchema = z.enum([
  'event',
  'task',
  'reminder',
  'snooze',
  'external_event',
  'note',
  'note_date'
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
  targetCalendarId: z.string().nullable().optional(),
  color: CalendarEventColorSchema.nullable().optional()
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
  targetCalendarId: z.string().nullable().optional(),
  color: CalendarEventColorSchema.nullable().optional()
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

/** #869: query-driven event lookup for pickers that must reach every event. */
export const SearchCalendarEventsSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().positive().max(100).default(20)
})

export const GetCalendarRangeSchema = z.object({
  startAt: z.string().datetime(),
  endAt: z.string().datetime(),
  includeUnselectedSources: z.boolean().default(false),
  // false = native memrynote events only, no Google-synced external events
  // (forced by the agent MCP surface for Google Workspace Limited Use).
  // Kept for older renderers; `externalProviders` narrows it per provider.
  includeExternal: z.boolean().optional(),
  // #1394: allow-list of providers whose external events may appear. The
  // agent read path sends exactly the providers the user consented to; an
  // empty list means no external events at all. Omitted = no filter.
  externalProviders: z.array(z.string().min(1)).max(64).optional()
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

/**
 * What a non-OAuth provider needs to connect (#1392). OAuth providers send no
 * connection payload; the flow runs in main.
 */
export const CalendarProviderConnectionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('url'),
    url: z.string().trim().min(1).max(4096),
    title: z.string().trim().max(200).optional()
  }),
  z.object({
    kind: z.literal('basic'),
    serverUrl: z.string().trim().min(1).max(4096),
    username: z.string().trim().min(1).max(320),
    password: z.string().min(1).max(1024),
    /** Server preset the user picked, for copy and telemetry only. */
    preset: z.string().trim().max(64).optional(),
    /** Remote calendar ids to show; omitted = the provider's default selection. */
    selectedCalendarIds: z.array(z.string().min(1).max(4096)).max(500).optional(),
    /**
     * #1396: the user saw the devices below CALENDAR_MULTI_WRITER_MIN_APP_VERSION
     * and chose to connect anyway. Without it, a writable provider refuses to
     * connect while such devices exist.
     */
    acknowledgeOutdatedDevices: z.boolean().optional()
  })
])

/**
 * The first build that never double-pushes an item another provider holds and
 * resolves a non-Google `target_calendar_id` correctly (#2372). A device below
 * it mishandles bindings and targets from a second writable provider (#1396),
 * so connecting one first lists those devices. Set to the release that ships
 * the write routing; anything built before it compares lower.
 */
export const CALENDAR_MULTI_WRITER_MIN_APP_VERSION = '2026.925.0'

export const CheckProviderWriterCompatSchema = z.object({
  provider: z.string().min(1)
})

export type CheckProviderWriterCompatInput = z.infer<typeof CheckProviderWriterCompatSchema>

export interface CalendarWriterCompatDevice {
  id: string
  name: string
  platform: string
  /** null when the server has no version for the device: treated as outdated. */
  appVersion: string | null
}

export interface CalendarWriterCompatResponse {
  /** false when connecting this provider adds no second writer (Google, read-only providers). */
  required: boolean
  /** false when the device list could not be read; the user must acknowledge blind. */
  verified: boolean
  minVersion: string
  outdatedDevices: CalendarWriterCompatDevice[]
}

export const CalendarProviderRequestSchema = z.object({
  provider: z.string().min(1),
  accountId: z.string().min(1).optional(),
  /** #1392: one source of a provider, for providers whose sources have no account (ICS). */
  sourceId: z.string().min(1).optional(),
  /** #1392: additive. Older callers send `{ provider }` only. */
  connection: CalendarProviderConnectionSchema.optional(),
  /** #1392: attach `capabilities` to the returned status. */
  includeCapabilities: z.boolean().optional()
})

export const ListProviderCalendarsSchema = z.object({
  provider: z.string().min(1)
})

export const SetDefaultProviderCalendarSchema = z.object({
  provider: z.string().min(1),
  calendarId: z.string().nullable(),
  markOnboardingComplete: z.boolean().default(true)
})

export const RetryCalendarSourceSyncSchema = z.object({
  sourceId: z.string().min(1)
})

export type RetryCalendarSourceSyncInput = z.infer<typeof RetryCalendarSourceSyncSchema>

/** `calendar_sources.provider` for read-only calendars subscribed by URL (#1207). */
export const ICS_CALENDAR_PROVIDER = 'ics'

/** `calendar_sources.provider` for the Google Calendar API provider. */
export const GOOGLE_CALENDAR_PROVIDER = 'google'

/**
 * Whether a provider's rows travel through sync. `synced` rows are enqueued
 * like any other record; `device` rows never leave the device that wrote them.
 */
export type CalendarProviderScope = 'synced' | 'device'

export type CalendarProviderIncrementalMode =
  'sync-token' | 'delta-link' | 'sync-collection' | 'ctag-etag' | 'conditional-get' | 'full'

export type CalendarProviderAuthFlow = 'oauth2' | 'basic' | 'url' | 'os-permission'

/** The `process.platform` values the desktop app ships on. */
export type CalendarProviderPlatform = 'darwin' | 'win32' | 'linux'

/**
 * What a calendar provider can do (#1391). Every "is this read-only / can this
 * be promoted / does this sync" decision reads these instead of comparing
 * provider ids.
 */
export interface CalendarProviderCapabilities {
  supportsWrite: boolean
  supportsCreateCalendar: boolean
  supportsPush: boolean
  supportsMultiAccount: boolean
  requiresMemryAccount: boolean
  /** Whether `calendar_external_events` mirrored from this provider sync. The cursor travels only if the mirror travels. */
  mirrorScope: CalendarProviderScope
  /** Whether the provider's `calendar_sources` rows themselves sync. */
  sourceScope: CalendarProviderScope
  /** Omitted = every platform. A provider outside its platforms does not exist there. */
  platforms?: CalendarProviderPlatform[]
  incrementalMode: CalendarProviderIncrementalMode
  authFlow: CalendarProviderAuthFlow
}

/**
 * Providers whose rows must never be enqueued by the shared sync handlers.
 * `@memry/sync-client` cannot read the desktop capability table, so the
 * device-local subset lives here and the desktop table is tested against it.
 *
 * - `sources`: `sourceScope: 'device'`. Their `calendar_sources` rows stay on the device.
 * - `mirrors`: `mirrorScope: 'device'`. Their `calendar_external_events` stay on the device.
 *   A device-local source always has a device-local mirror, so `sources` is a subset.
 */
export const DEVICE_LOCAL_CALENDAR_PROVIDERS: {
  readonly sources: readonly string[]
  readonly mirrors: readonly string[]
} = {
  sources: [],
  mirrors: [ICS_CALENDAR_PROVIDER]
}

/**
 * Why a feed could not be fetched or read. Stored as `calendar_sources.last_error`
 * for ICS sources, so each device's renderer localizes it rather than showing a
 * message written in another device's language.
 */
export const IcsFeedErrorCodeSchema = z.enum([
  'invalid_url',
  'unreachable',
  'timeout',
  'not_found',
  'unauthorized',
  'http_error',
  'too_large',
  'not_a_calendar'
])

export const SubscribeIcsCalendarSchema = z.object({
  url: z.string().trim().min(1).max(4096),
  title: z.string().trim().max(200).optional()
})

export const IcsCalendarSourceRequestSchema = z.object({
  sourceId: z.string().min(1)
})

export type IcsFeedErrorCode = z.infer<typeof IcsFeedErrorCodeSchema>
export type SubscribeIcsCalendarInput = z.infer<typeof SubscribeIcsCalendarSchema>
export type IcsCalendarSourceRequest = z.infer<typeof IcsCalendarSourceRequestSchema>

export interface IcsCalendarMutationResponse {
  success: boolean
  source: CalendarSourceRecord | null
  errorCode?: IcsFeedErrorCode
  error?: string
}

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
export type SearchCalendarEventsInput = z.infer<typeof SearchCalendarEventsSchema>
export type GetCalendarRangeInput = z.infer<typeof GetCalendarRangeSchema>
export type ListCalendarSourcesInput = z.infer<typeof ListCalendarSourcesSchema>
export type UpdateCalendarSourceSelectionInput = z.infer<typeof UpdateCalendarSourceSelectionSchema>
export type CalendarProviderRequest = z.infer<typeof CalendarProviderRequestSchema>
export type CalendarProviderConnection = z.infer<typeof CalendarProviderConnectionSchema>
export type ListProviderCalendarsInput = z.infer<typeof ListProviderCalendarsSchema>
export type SetDefaultProviderCalendarInput = z.infer<typeof SetDefaultProviderCalendarSchema>
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
  /** Google Calendar's colour id, as stored and synced. Read `color` instead. */
  colorId: string | null
  color: CalendarEventColor | null
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
  /**
   * Minutes the reminder has been snoozed from its original `remindAt`.
   * Positive = snoozed into the future, negative = pulled earlier.
   * Null for non-reminders or reminders with no active snooze.
   */
  snoozeOffsetMinutes: number | null
  /**
   * For `note_date` items: the source note id and the inline date pill's stable
   * anchor id, so a click can open the note scrolled to that exact pill.
   * Undefined for item types that don't navigate to a note anchor.
   */
  noteId?: string | null
  anchorId?: string | null
  /**
   * For `note_date` items: true once the reminder has fired (status `triggered`
   * or `dismissed`). The chip is kept on the calendar but rendered faded so the
   * date isn't lost. Undefined/false for upcoming or non-`note_date` items.
   */
  isTriggered?: boolean
  /**
   * For `event` and `external_event` items: the event's own colour, set in
   * Memry or in Google. Null when the event shows its calendar's colour.
   * Undefined for other item types.
   */
  color?: CalendarEventColor | null
  /**
   * The `#rrggbb` to paint the item with: the event's own colour, else the
   * colour of the Google calendar it lives on. Null or undefined keeps the
   * item-type colour.
   */
  displayColor?: string | null
}

export type CalendarProviderAccountConnectionStatus =
  'connected' | 'disconnected' | 'reconnect_required' | 'error'

export interface CalendarProviderAccountStatus {
  accountId: string
  email: string
  status: CalendarProviderAccountConnectionStatus
  lastSyncedAt: string | null
  lastError: string | null
}

export interface CalendarProviderStatus {
  provider: string
  /** #1392: optional so an older renderer that ignores it keeps working. */
  capabilities?: CalendarProviderCapabilities
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

/**
 * Lean event summary for pickers: exactly the fields a card candidate needs.
 * Deliberately not CalendarEventRecord — attendees, reminders, conferenceData
 * and clocks are dead weight over IPC for a search result.
 */
export interface CalendarEventSearchItem {
  id: string
  title: string
  startAt: string
  endAt: string | null
  isAllDay: boolean
}

export interface CalendarEventSearchResponse {
  events: CalendarEventSearchItem[]
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
  /** #1392: a code the renderer localizes (an `IcsFeedErrorCode`, a CalDAV connect failure). */
  errorCode?: string
  /** #1392: the source a URL connect created or a per-source refresh touched. */
  source?: CalendarSourceRecord | null
}

export interface CalendarProviderDescriptor {
  id: string
  capabilities: CalendarProviderCapabilities
}

export interface ListCalendarProvidersResponse {
  providers: CalendarProviderDescriptor[]
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

export type ProviderCalendarDescriptorRecord = GoogleCalendarDescriptorRecord

export interface ListProviderCalendarsResponse {
  provider: string
  calendars: ProviderCalendarDescriptorRecord[]
  primary: ProviderCalendarDescriptorRecord | null
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

export type SetDefaultProviderCalendarResponse = SetDefaultGoogleCalendarResponse
