import type {
  CalendarProviderAccountConnectionStatus,
  CalendarProviderAccountStatus,
  CalendarProviderStatus
} from '@memry/contracts/calendar-api'
import type { calendarSources } from '@memry/db-schema/schema/calendar-sources'
import type { DataDb } from '../../database'
import { listCalendarSources } from '../repositories/calendar-sources-repository'
import { getProvider } from './registry'

async function buildProviderAccountStatus(
  db: DataDb,
  source: typeof calendarSources.$inferSelect
): Promise<CalendarProviderAccountStatus | null> {
  const accountId = source.accountId
  if (!accountId) return null

  const metadata =
    (source.metadata as {
      email?: string
      lastError?: string
      serverUrl?: string
      username?: string
      preset?: string | null
    } | null) ?? null
  const definition = getProvider(source.provider)
  const hasLocalAuth = definition ? await definition.hasAccountLocalAuth(db, accountId) : false

  let status: CalendarProviderAccountConnectionStatus
  const reconnectReason =
    !hasLocalAuth && definition?.accountReconnectReason
      ? await definition.accountReconnectReason(db, accountId)
      : null
  if (!hasLocalAuth) {
    status = 'reconnect_required'
  } else if (source.syncStatus === 'error') {
    status = 'error'
  } else {
    status = 'connected'
  }

  return {
    accountId,
    email: metadata?.email ?? source.title,
    status,
    lastSyncedAt: source.lastSyncedAt ?? null,
    lastError: source.lastError ?? metadata?.lastError ?? null,
    ...(reconnectReason ? { reconnectReason } : {}),
    // Basic-auth accounts only: what a reconnect form prefills.
    ...(metadata?.serverUrl && metadata.username
      ? {
          serverUrl: metadata.serverUrl,
          username: metadata.username,
          preset: metadata.preset ?? null
        }
      : {})
  }
}

/**
 * The provider's connection state as the settings UI reads it. `capabilities`
 * is attached only on request: responses to existing callers keep the exact
 * shape they always had.
 */
export async function buildProviderStatus(
  db: DataDb,
  provider: string,
  options: { includeCapabilities?: boolean } = {}
): Promise<CalendarProviderStatus> {
  const allSources = listCalendarSources(db, { provider })
  const accountSources = allSources.filter((source) => source.kind === 'account')
  const account = accountSources[0] ?? null
  const calendars = allSources.filter((source) => source.kind === 'calendar')
  const syncedCandidates = [
    ...accountSources.map((source) => source.lastSyncedAt ?? null),
    ...calendars.map((source) => source.lastSyncedAt ?? null)
  ].filter((value): value is string => Boolean(value))
  const definition = getProvider(provider)
  const hasLocalAuth = definition ? await definition.hasAnyLocalAuth(db) : false

  const accounts: CalendarProviderAccountStatus[] = []
  for (const source of accountSources) {
    const accountStatus = await buildProviderAccountStatus(db, source)
    if (accountStatus) accounts.push(accountStatus)
  }

  return {
    provider,
    ...(definition && options.includeCapabilities ? { capabilities: definition.capabilities } : {}),
    connected: Boolean(account),
    hasLocalAuth,
    account: account ? { id: account.id, title: account.title } : null,
    accounts,
    calendars: {
      total: calendars.length,
      selected: calendars.filter((source) => source.isSelected).length,
      memryManaged: calendars.filter((source) => source.isMemryManaged).length
    },
    lastSyncedAt: syncedCandidates.sort().at(-1) ?? null
  }
}
