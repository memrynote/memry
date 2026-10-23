import type { CalendarRangeResponse, GetCalendarRangeInput } from '@memry/contracts/calendar-api'
import type {
  CalendarConferenceData,
  CalendarReminders,
  CalendarVisibility
} from '@memry/db-schema/data-schema'

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
  attendees: unknown[] | null
  reminders: CalendarReminders | null
  visibility: CalendarVisibility | null
  colorId: string | null
  conferenceData: CalendarConferenceData | null
  targetCalendarId: string | null
  archivedAt: string | null
  createdAt: string
  modifiedAt: string
}

export interface CreateCalendarEventInput {
  title: string
  startAt: string
  endAt?: string | null
  timezone?: string
  description?: string | null
  location?: string | null
  isAllDay?: boolean
  recurrenceRule?: Record<string, unknown> | null
  recurrenceExceptions?: string[] | null
  targetCalendarId?: string | null
}

export interface UpdateCalendarEventInput {
  title?: string
  startAt?: string
  endAt?: string | null
  timezone?: string
  description?: string | null
  location?: string | null
  isAllDay?: boolean
  recurrenceRule?: Record<string, unknown> | null
  recurrenceExceptions?: string[] | null
  targetCalendarId?: string | null
}

export interface ListCalendarEventsOptions {
  includeArchived?: boolean
  start?: string
  end?: string
}

export interface CalendarSourceRecord {
  id: string
  provider: string
  kind: 'account' | 'calendar'
  accountId: string | null
  remoteId: string
  title: string
  timezone: string | null
  color: string | null
  isPrimary: boolean
  isSelected: boolean
  isMemryManaged: boolean
  syncStatus: string
  lastSyncedAt: string | null
  lastError: string | null
  archivedAt: string | null
}

export interface CalendarExternalEventRecord {
  id: string
  sourceId: string
  remoteEventId: string
  remoteEtag: string | null
  remoteUpdatedAt: string | null
  title: string
  description: string | null
  location: string | null
  startAt: string
  endAt: string | null
  timezone: string | null
  isAllDay: boolean
  status: string
  recurrenceRule: Record<string, unknown> | null
  attendees: unknown[] | null
  reminders: CalendarReminders | null
  visibility: CalendarVisibility | null
  colorId: string | null
  conferenceData: CalendarConferenceData | null
  rawPayload: Record<string, unknown> | null
  archivedAt: string | null
  syncedAt: string | null
  createdAt: string
  modifiedAt: string
}

export interface ListCalendarExternalEventsOptions {
  sourceId?: string
  includeArchived?: boolean
  start?: string
  end?: string
}

export interface CalendarBindingRecord {
  id: string
  sourceType: string
  sourceId: string
  provider: string
  remoteCalendarId: string
  remoteEventId: string
  ownershipMode: string
  writebackMode: string
  remoteVersion: string | null
  lastLocalSnapshot: Record<string, unknown> | null
  archivedAt: string | null
  syncedAt: string | null
  createdAt: string
  modifiedAt: string
}

export interface ListCalendarBindingsOptions {
  sourceType?: string
  sourceId?: string
  provider?: string
  includeArchived?: boolean
}

export interface CalendarGoogleSettings {
  defaultTargetCalendarId: string | null
  onboardingCompleted: boolean
  promoteConfirmDismissed: boolean
}

export interface ListCalendarSourcesOptions {
  provider?: string
  kind?: 'account' | 'calendar'
  selectedOnly?: boolean
}

export interface CalendarService {
  events: {
    create(input: CreateCalendarEventInput): Promise<CalendarEventRecord>
    get(id: string): Promise<CalendarEventRecord | null>
    list(options?: ListCalendarEventsOptions): Promise<CalendarEventRecord[]>
    update(id: string, input: UpdateCalendarEventInput): Promise<CalendarEventRecord>
    delete(id: string): Promise<boolean>
  }
  sources: {
    list(options?: ListCalendarSourcesOptions): Promise<{ sources: CalendarSourceRecord[] }>
    updateSelection(
      id: string,
      isSelected: boolean
    ): Promise<{ success: boolean; source: CalendarSourceRecord | null }>
  }
  external: {
    get(id: string): Promise<CalendarExternalEventRecord | null>
    list(
      options?: ListCalendarExternalEventsOptions
    ): Promise<{ events: CalendarExternalEventRecord[] }>
    promote(id: string): Promise<{ success: boolean; eventId: string | null }>
  }
  bindings: {
    get(id: string): Promise<CalendarBindingRecord | null>
    list(options?: ListCalendarBindingsOptions): Promise<{ bindings: CalendarBindingRecord[] }>
  }
  providerStatus(input: {
    provider: string
    accountId?: string
  }): Promise<{ provider: string; accountId?: string; connected: boolean; sourceCount: number }>
  range(input: GetCalendarRangeInput): Promise<CalendarRangeResponse>
  googleSettings(): Promise<CalendarGoogleSettings>
  setDefaultGoogleCalendar(
    calendarId: string | null,
    markOnboardingComplete?: boolean
  ): Promise<{ success: boolean }>
}
