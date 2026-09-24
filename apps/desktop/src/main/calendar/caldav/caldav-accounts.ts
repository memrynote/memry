import { createHash } from 'node:crypto'
import { and, eq, isNull } from 'drizzle-orm'
import { CALDAV_CALENDAR_PROVIDER } from '@memry/contracts/calendar-api'
import { calendarSources, type CalendarSource } from '@memry/db-schema/schema/calendar-sources'
import type { DataDb } from '../../database'
import { getSetting, setSetting } from '../../settings/settings-store'
import { deleteProviderSecret, getProviderSecret, setProviderSecret } from '../provider/secrets'
import { createCaldavTransport, type CaldavTransport, type FetchLike } from './caldav-transport'

/**
 * CalDAV accounts: ids, the synced metadata a second device needs to ask for
 * just the password, the app password in this device's secret storage, and
 * this device's "the server rejected the password" marker.
 */

export const CALDAV = CALDAV_CALENDAR_PROVIDER

/** What the account row carries across devices. Never the password. */
export interface CaldavAccountMetadata {
  connectedVia: 'basic'
  /** Shown as the account's name. */
  email: string
  serverUrl: string
  username: string
  principalUrl: string
  homeUrl: string
  preset: string | null
}

/**
 * Accepts `caldav.icloud.com`, `https://dav.example.com/remote.php/dav`,
 * `http://192.168.1.5:5232`. A bare host gets `https://`; plain HTTP is kept
 * only when the user typed it (a LAN server).
 */
export function normalizeCaldavServerUrl(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  if (!url.hostname) return null
  url.hash = ''
  url.search = ''
  if (!url.pathname.endsWith('/')) url.pathname = `${url.pathname}/`
  return url.href
}

/** Same server and user, same account id, on every device. */
export function caldavAccountId(serverUrl: string, username: string): string {
  const digest = createHash('sha256')
    .update(`${serverUrl}\n${username.trim().toLowerCase()}`)
    .digest('hex')
    .slice(0, 24)
  return `caldav-${digest}`
}

export function caldavAccountSourceId(accountId: string): string {
  return `caldav-account:${accountId}`
}

/** Same collection URL, same source row, on every device. */
export function caldavCalendarSourceId(collectionUrl: string): string {
  return `caldav-calendar:${createHash('sha256').update(collectionUrl).digest('hex').slice(0, 32)}`
}

export function readAccountMetadata(source: CalendarSource): CaldavAccountMetadata | null {
  const metadata = source.metadata as Partial<CaldavAccountMetadata> | null
  if (!metadata?.serverUrl || !metadata.username) return null
  return {
    connectedVia: 'basic',
    email: metadata.email ?? metadata.username,
    serverUrl: metadata.serverUrl,
    username: metadata.username,
    principalUrl: metadata.principalUrl ?? metadata.serverUrl,
    homeUrl: metadata.homeUrl ?? metadata.serverUrl,
    preset: metadata.preset ?? null
  }
}

export function listCaldavAccountSources(db: DataDb): CalendarSource[] {
  return db
    .select()
    .from(calendarSources)
    .where(
      and(
        eq(calendarSources.provider, CALDAV),
        eq(calendarSources.kind, 'account'),
        isNull(calendarSources.archivedAt)
      )
    )
    .all()
}

export function getCaldavAccountSource(db: DataDb, accountId: string): CalendarSource | null {
  return listCaldavAccountSources(db).find((source) => source.accountId === accountId) ?? null
}

export async function storeCaldavPassword(
  accountId: string,
  password: string | null
): Promise<void> {
  await setProviderSecret(CALDAV, accountId, 'password', password)
}

export async function readCaldavPassword(accountId: string): Promise<string | null> {
  return await getProviderSecret(CALDAV, accountId, 'password')
}

export async function forgetCaldavPassword(accountId: string): Promise<void> {
  await deleteProviderSecret(CALDAV, accountId, 'password')
}

// This device only: the settings table does not sync. A server rejecting the
// password on one device says nothing about another device's password.
const AUTH_FAILURES_KEY = 'calendar.caldav.authFailures'

function readAuthFailures(db: DataDb): Record<string, true> {
  const raw = getSetting(db, AUTH_FAILURES_KEY)
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, true>) : {}
  } catch {
    return {}
  }
}

export function hasCaldavAuthFailure(db: DataDb, accountId: string): boolean {
  return readAuthFailures(db)[accountId] === true
}

export function setCaldavAuthFailure(db: DataDb, accountId: string, failed: boolean): void {
  const current = readAuthFailures(db)
  if (Boolean(current[accountId]) === failed) return
  if (failed) current[accountId] = true
  else delete current[accountId]
  setSetting(db, AUTH_FAILURES_KEY, JSON.stringify(current))
}

/**
 * Whether this device can sync the account: it holds the app password and
 * the server has not rejected it since. A revoked app password (resetting an
 * Apple ID password revokes all of them) shows as `reconnect_required`.
 */
export async function hasCaldavLocalAuth(db: DataDb, accountId: string): Promise<boolean> {
  if (hasCaldavAuthFailure(db, accountId)) return false
  return Boolean(await readCaldavPassword(accountId))
}

export interface CaldavTransportDeps {
  fetchImpl?: FetchLike
  timeoutMs?: number
}

/** A transport for a stored account, or null when this device has no password for it. */
export async function transportForAccount(
  account: CalendarSource,
  deps: CaldavTransportDeps = {}
): Promise<CaldavTransport | null> {
  const metadata = readAccountMetadata(account)
  if (!metadata || !account.accountId) return null
  const password = await readCaldavPassword(account.accountId)
  if (!password) return null
  return createCaldavTransport({
    serverUrl: metadata.serverUrl,
    credentials: { username: metadata.username, password },
    fetchImpl: deps.fetchImpl,
    timeoutMs: deps.timeoutMs
  })
}
