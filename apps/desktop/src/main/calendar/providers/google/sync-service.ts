import type { calendarBindings } from '@memry/db-schema/schema/calendar-bindings'
import type { calendarSources } from '@memry/db-schema/schema/calendar-sources'
import { requireDatabase, type DataDb } from '../../../database'
import {
  hasGoogleCalendarConnection,
  listGoogleAccountIds,
  resolveDefaultGoogleAccountId
} from './oauth'
import { resolveTargetGoogleAccountId } from './account-routing'
import { createGoogleCalendarClient } from './client'
import { readCalendarGoogleSettings } from './calendar-google-settings'
import { GOOGLE_CAPABILITIES, GOOGLE_PROVIDER_ID } from './capabilities'
import {
  applyProviderDelete,
  applyProviderWriteback,
  deleteSourceFromProvider,
  discoverProviderSources,
  ensureProviderCalendarSourceSelected,
  pushSourceToProvider,
  syncLocalSourceToProvider,
  syncProviderNow,
  syncProviderSource,
  type ProviderSyncContext
} from '../../sync/engine'
import type {
  CalendarSyncTarget,
  GoogleCalendarClient,
  GoogleCalendarRemoteEvent
} from '../../types'

/**
 * Google, expressed as one provider the generic engine can drive.
 *
 * Everything below is a thin binding: the engine owns discovery, push,
 * writeback, delete and per-source sync; this file only says how Google
 * authenticates, which account a push routes to, and where its settings live.
 * The Google-named exports are kept so every existing caller and test keeps
 * its import path.
 */
export const googleSyncContext: ProviderSyncContext = {
  providerId: GOOGLE_PROVIDER_ID,
  capabilities: GOOGLE_CAPABILITIES,
  createAdapter: (accountId) => createGoogleCalendarClient({ accountId }),
  listAccountIds: (db) => listGoogleAccountIds(db),
  resolveDefaultAccountId: (db) => resolveDefaultGoogleAccountId(db),
  hasConnection: (db) => hasGoogleCalendarConnection(db),
  isPushEnabled: (db) => readCalendarGoogleSettings(db).pushEventsToGoogle,
  resolveTargetAccountId: (db, target, existingBinding) =>
    resolveTargetGoogleAccountId(db, target, existingBinding),
  readDefaultTargetCalendarId: (db) => readCalendarGoogleSettings(db).defaultTargetCalendarId
}

export async function discoverGoogleCalendarSources(
  db: DataDb,
  client: Pick<GoogleCalendarClient, 'listCalendars'>,
  accountId: string
): Promise<void> {
  return await discoverProviderSources(db, googleSyncContext, client, accountId)
}

export async function ensureGoogleCalendarSourceSelected(
  db: DataDb,
  client: Pick<GoogleCalendarClient, 'listCalendars'>,
  remoteCalendarId: string,
  accountId: string
): Promise<typeof calendarSources.$inferSelect | null> {
  return await ensureProviderCalendarSourceSelected(
    db,
    googleSyncContext,
    client,
    remoteCalendarId,
    accountId
  )
}

export async function pushSourceToGoogleCalendar(
  db: DataDb,
  target: CalendarSyncTarget,
  deps: {
    client?: Pick<
      GoogleCalendarClient,
      'upsertEvent' | 'listCalendars' | 'createCalendar' | 'getEvent'
    >
  } = {}
): Promise<typeof calendarBindings.$inferSelect> {
  return await pushSourceToProvider(db, googleSyncContext, target, {
    adapter: deps.client as GoogleCalendarClient | undefined
  })
}

export async function deleteSourceFromGoogleCalendar(
  db: DataDb,
  target: CalendarSyncTarget,
  deps: { client?: Pick<GoogleCalendarClient, 'deleteEvent'> } = {}
): Promise<boolean> {
  return await deleteSourceFromProvider(db, googleSyncContext, target, {
    adapter: deps.client as GoogleCalendarClient | undefined
  })
}

export async function syncLocalSourceToGoogleCalendar(
  db: DataDb,
  target: CalendarSyncTarget,
  deps: {
    client?: Pick<
      GoogleCalendarClient,
      'upsertEvent' | 'deleteEvent' | 'listCalendars' | 'createCalendar' | 'getEvent'
    >
  } = {}
): Promise<typeof calendarBindings.$inferSelect | null> {
  return await syncLocalSourceToProvider(db, googleSyncContext, target, {
    adapter: deps.client as GoogleCalendarClient | undefined
  })
}

export async function applyGoogleCalendarWriteback(
  db: DataDb,
  binding: Pick<typeof calendarBindings.$inferSelect, 'sourceType' | 'sourceId' | 'writebackMode'>,
  remote: GoogleCalendarRemoteEvent
): Promise<void> {
  return await applyProviderWriteback(db, googleSyncContext, binding, remote)
}

export async function applyGoogleCalendarDelete(
  db: DataDb,
  binding: Pick<typeof calendarBindings.$inferSelect, 'sourceType' | 'sourceId' | 'writebackMode'>
): Promise<void> {
  return await applyProviderDelete(db, googleSyncContext, binding)
}

export async function syncGoogleCalendarSource(
  db: DataDb,
  sourceId: string,
  deps: { client?: Pick<GoogleCalendarClient, 'listEvents'> } = {}
): Promise<void> {
  return await syncProviderSource(db, googleSyncContext, sourceId, { adapter: deps.client })
}

export async function syncGoogleCalendarNow(
  db: DataDb = requireDatabase(),
  deps: { client?: GoogleCalendarClient } = {}
): Promise<void> {
  return await syncProviderNow(db, googleSyncContext, { adapter: deps.client })
}

// Runner lifecycle + push-channel poll cadence live in google-sync-runner.ts.
// Re-exported here so existing callers (index.ts, calendar-handlers,
// session-teardown, device-registration, tests) keep their import paths.
export {
  PUSH_BACKOFF_INTERVAL_MS,
  getCurrentPollIntervalMs,
  reEvaluatePollCadence,
  startGoogleCalendarSyncRunner,
  stopGoogleCalendarSyncRunner,
  triggerGoogleCalendarSyncNow
} from './google-sync-runner'
