import type {
  CalendarProviderCapabilities,
  ListProviderCalendarsResponse,
  SetDefaultProviderCalendarResponse
} from '@memry/contracts/calendar-api'
import type { DataDb } from '../../../database/types'
import type { CalendarProviderDefinition, ProviderConnectResult } from '../../provider/registry'
import { createGoogleCalendarClient } from './client'
import { listGoogleCalendars, setDefaultGoogleCalendar } from './onboarding'
import {
  connectGoogleCalendar,
  disconnectGoogleCalendar,
  hasAnyGoogleCalendarLocalAuth,
  hasGoogleCalendarLocalAuth,
  listGoogleAccountIds,
  resolveDefaultGoogleAccountId
} from './oauth'
import {
  discoverGoogleCalendarSources,
  startGoogleCalendarSyncRunner,
  stopGoogleCalendarSyncRunner,
  syncGoogleCalendarNow,
  syncGoogleCalendarSource
} from './sync-service'

export const GOOGLE_PROVIDER_ID = 'google'

export const GOOGLE_CAPABILITIES: CalendarProviderCapabilities = {
  supportsWrite: true,
  supportsCreateCalendar: true,
  supportsPush: true,
  supportsMultiAccount: true,
  incrementalMode: 'sync-token',
  authFlow: 'oauth2'
}

export const googleProviderDefinition: CalendarProviderDefinition = {
  id: GOOGLE_PROVIDER_ID,
  capabilities: GOOGLE_CAPABILITIES,

  createAdapter(accountId: string) {
    return createGoogleCalendarClient({ accountId })
  },

  async connect(): Promise<ProviderConnectResult> {
    return await connectGoogleCalendar()
  },

  async disconnect(accountId: string): Promise<void> {
    await disconnectGoogleCalendar(accountId)
  },

  listAccountIds(db: DataDb): string[] {
    return listGoogleAccountIds(db)
  },

  resolveDefaultAccountId(db: DataDb): string | null {
    return resolveDefaultGoogleAccountId(db)
  },

  async listCalendars(db: DataDb): Promise<ListProviderCalendarsResponse> {
    const accountId = resolveDefaultGoogleAccountId(db)
    if (!accountId) {
      return { calendars: [], primary: null, currentDefaultId: null }
    }
    return await listGoogleCalendars(db, createGoogleCalendarClient({ accountId }))
  },

  setDefaultCalendar(
    db: DataDb,
    input: { calendarId: string | null; markOnboardingComplete: boolean }
  ): SetDefaultProviderCalendarResponse {
    // Still writes the `calendar.google` settings group verbatim; the
    // per-provider settings namespace lands in #1394.
    return setDefaultGoogleCalendar(db, input)
  },

  async hasLocalAuth(db: DataDb): Promise<boolean> {
    return await hasAnyGoogleCalendarLocalAuth(db)
  },

  async hasAccountLocalAuth(accountId: string): Promise<boolean> {
    return await hasGoogleCalendarLocalAuth(accountId)
  },

  async discoverSources(db: DataDb, accountId: string): Promise<void> {
    await discoverGoogleCalendarSources(db, createGoogleCalendarClient({ accountId }), accountId)
  },

  async syncNow(db: DataDb): Promise<void> {
    await syncGoogleCalendarNow(db)
  },

  async syncSource(db: DataDb, sourceId: string): Promise<void> {
    await syncGoogleCalendarSource(db, sourceId)
  },

  async startSyncRunner(): Promise<void> {
    await startGoogleCalendarSyncRunner()
  },

  stopSyncRunner(): void {
    stopGoogleCalendarSyncRunner()
  }
}
