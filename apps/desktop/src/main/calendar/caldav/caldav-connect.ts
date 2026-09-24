import { and, eq, inArray } from 'drizzle-orm'
import { calendarSources, type CalendarSource } from '@memry/db-schema/schema/calendar-sources'
import type { DataDb } from '../../database'
import { createLogger } from '../../lib/logger'
import { emitCalendarChanged } from '../change-events'
import { getCalendarSourceById } from '../repositories/calendar-sources-repository'
import { syncCalendarSourceUpdate } from '../runtime-effects'
import { ProviderAuthError, type ProviderError } from '../provider/errors'
import { purgeCalendarSourceMirrors, upsertSyncedCalendarSource } from '../provider/source-mirrors'
import { dropStaleDefaultWriteTarget } from '../provider/write-routing'
import {
  CALDAV,
  caldavAccountId,
  caldavAccountSourceId,
  caldavCalendarSourceId,
  forgetCaldavPassword,
  listCaldavAccountSources,
  normalizeCaldavServerUrl,
  setCaldavAuthFailure,
  storeCaldavPassword,
  type CaldavAccountMetadata
} from './caldav-accounts'
import {
  classifyCaldavFailure,
  discoverCaldavAccount,
  type CaldavAccountInfo
} from './caldav-client'
import { createCaldavTransport, type FetchLike } from './caldav-transport'

const log = createLogger('Calendar:CaldavConnect')

/** Why a connect or a connection test failed, as a code the renderer localizes. */
export type CaldavConnectErrorCode =
  | 'invalid_url'
  | 'unauthorized'
  | 'unreachable'
  | 'not_caldav'
  | 'no_calendars'
  | 'outdated_devices'

export class CaldavConnectError extends Error {
  constructor(
    readonly code: CaldavConnectErrorCode,
    message?: string,
    options?: { cause?: unknown }
  ) {
    super(message ?? code, options)
    this.name = 'CaldavConnectError'
  }
}

export interface CaldavConnectInput {
  serverUrl: string
  username: string
  password: string
  preset?: string | null
  /** Collection URLs to show; omitted = every calendar that holds events. */
  selectedCalendarIds?: string[]
}

export interface CaldavConnectDeps {
  fetchImpl?: FetchLike
  timeoutMs?: number
}

function connectFailure(error: unknown, mapped: ProviderError | null): CaldavConnectError {
  if (error instanceof CaldavConnectError) return error
  if (mapped instanceof ProviderAuthError) {
    return new CaldavConnectError('unauthorized', mapped.message, { cause: error })
  }
  if (mapped) return new CaldavConnectError('unreachable', mapped.message, { cause: error })
  return new CaldavConnectError('not_caldav', error instanceof Error ? error.message : undefined, {
    cause: error
  })
}

/**
 * Run discovery with the given credentials and report what it found, saving
 * nothing. The connect form's "Test connection" and `connectCaldavAccount`
 * both start here, so an account is only ever saved after this worked (the
 * rule the ICS flow already follows).
 */
export async function discoverCaldavCalendars(
  input: Pick<CaldavConnectInput, 'serverUrl' | 'username' | 'password'>,
  deps: CaldavConnectDeps = {}
): Promise<CaldavAccountInfo> {
  const serverUrl = normalizeCaldavServerUrl(input.serverUrl)
  if (!serverUrl) throw new CaldavConnectError('invalid_url')
  const transport = createCaldavTransport({
    serverUrl,
    credentials: { username: input.username.trim(), password: input.password },
    fetchImpl: deps.fetchImpl,
    timeoutMs: deps.timeoutMs
  })
  let info: CaldavAccountInfo
  try {
    info = await discoverCaldavAccount(serverUrl, transport)
  } catch (error) {
    throw connectFailure(error, classifyCaldavFailure(error, transport))
  }
  if (info.calendars.length === 0) throw new CaldavConnectError('no_calendars')
  return info
}

/**
 * Connect (or reconnect) a CalDAV account. Creates one `account` source and
 * one `calendar` source per collection that holds events; stores the app
 * password in this device's secret storage only. Reconnecting the same
 * server and user revives the same rows, keeps the user's calendar choices,
 * and clears this device's "password rejected" state.
 */
export async function connectCaldavAccount(
  db: DataDb,
  input: CaldavConnectInput,
  deps: CaldavConnectDeps = {}
): Promise<{ accountId: string; info: CaldavAccountInfo }> {
  const info = await discoverCaldavCalendars(input, deps)
  const username = input.username.trim()
  const accountId = caldavAccountId(info.serverUrl, username)
  await storeCaldavPassword(accountId, input.password)
  setCaldavAuthFailure(db, accountId, false)

  const now = new Date().toISOString()
  const metadata: CaldavAccountMetadata = {
    connectedVia: 'basic',
    email: username,
    serverUrl: info.serverUrl,
    username,
    principalUrl: info.principalUrl,
    homeUrl: info.homeUrl,
    preset: input.preset ?? null
  }
  upsertSyncedCalendarSource(db, {
    id: caldavAccountSourceId(accountId),
    provider: CALDAV,
    kind: 'account',
    accountId,
    remoteId: info.principalUrl,
    title: username,
    timezone: null,
    color: null,
    isPrimary: false,
    isSelected: false,
    isMemryManaged: false,
    syncStatus: 'ok',
    lastSyncedAt: now,
    lastError: null,
    metadata: metadata as unknown as Record<string, unknown>,
    archivedAt: null,
    createdAt: now,
    modifiedAt: now
  })

  const chosen = input.selectedCalendarIds ? new Set(input.selectedCalendarIds) : null
  const discovered = new Set<string>()
  for (const calendar of info.calendars) {
    const id = caldavCalendarSourceId(calendar.url)
    discovered.add(id)
    const existing = getCalendarSourceById(db, id)
    upsertSyncedCalendarSource(db, {
      ...existing,
      id,
      provider: CALDAV,
      kind: 'calendar',
      accountId,
      remoteId: calendar.url,
      title: calendar.displayName,
      timezone: calendar.timezone,
      color: calendar.color,
      isPrimary: false,
      isSelected: chosen ? chosen.has(calendar.url) : (existing?.isSelected ?? true),
      isMemryManaged: false,
      syncCursor: existing?.archivedAt ? null : (existing?.syncCursor ?? null),
      syncStatus: existing?.syncStatus ?? 'pending',
      metadata: { supportsSyncCollection: calendar.supportsSyncCollection },
      archivedAt: null,
      createdAt: existing?.createdAt ?? now,
      modifiedAt: now
    })
  }

  // Calendars the server no longer lists for this account are gone.
  const vanished = db
    .select()
    .from(calendarSources)
    .where(
      and(
        eq(calendarSources.provider, CALDAV),
        eq(calendarSources.kind, 'calendar'),
        eq(calendarSources.accountId, accountId)
      )
    )
    .all()
    .filter((source) => !discovered.has(source.id) && !source.archivedAt)
  archiveSources(db, vanished)

  log.info('Connected CalDAV account', {
    host: new URL(info.serverUrl).hostname,
    calendars: info.calendars.length
  })
  return { accountId, info }
}

function archiveSources(db: DataDb, sources: CalendarSource[]): void {
  if (sources.length === 0) return
  // Mirrors first, then the tombstones (same order as Google's disconnect).
  purgeCalendarSourceMirrors(db, CALDAV, sources)
  const now = new Date().toISOString()
  db.update(calendarSources)
    .set({ archivedAt: now, modifiedAt: now })
    .where(
      inArray(
        calendarSources.id,
        sources.map((source) => source.id)
      )
    )
    .run()
  for (const source of sources) {
    syncCalendarSourceUpdate(source.id)
    emitCalendarChanged({ entityType: 'calendar_source', id: source.id })
  }
  dropStaleDefaultWriteTarget(db)
}

/**
 * Disconnect one account, or every CalDAV account. Forgets this device's
 * password, removes the mirrored events and tombstones the rows (synced), so
 * nothing reads from or writes to that server afterwards.
 */
export async function disconnectCaldavAccount(db: DataDb, accountId?: string): Promise<number> {
  const accounts = listCaldavAccountSources(db).filter(
    (account) => !accountId || account.accountId === accountId
  )
  const accountIds = new Set(
    accounts.map((account) => account.accountId).filter((id): id is string => Boolean(id))
  )
  if (accountId) accountIds.add(accountId)
  for (const id of accountIds) {
    try {
      await forgetCaldavPassword(id)
    } catch (error) {
      log.warn('Could not forget a CalDAV password', { error })
    }
    setCaldavAuthFailure(db, id, false)
  }
  const sources = db
    .select()
    .from(calendarSources)
    .where(eq(calendarSources.provider, CALDAV))
    .all()
    .filter((source) => !source.archivedAt && source.accountId && accountIds.has(source.accountId))
  archiveSources(db, sources)
  return accountIds.size
}
