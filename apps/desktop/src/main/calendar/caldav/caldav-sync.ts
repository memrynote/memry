import { and, eq, isNull } from 'drizzle-orm'
import { calendarSources, type CalendarSource } from '@memry/db-schema/schema/calendar-sources'
import type { DataDb } from '../../database'
import { createLogger } from '../../lib/logger'
import { emitCalendarChanged, emitCalendarProjectionChanged } from '../change-events'
import {
  getCalendarSourceById,
  upsertCalendarSource
} from '../repositories/calendar-sources-repository'
import { syncCalendarSourceUpdate } from '../runtime-effects'
import { ProviderAuthError, ProviderRateLimitError, type ProviderError } from '../provider/errors'
import { pullWithCursorReset } from '../sync/cursor-reset'
import { runExclusive } from '../sync/write-engine'
import {
  CALDAV,
  hasCaldavAuthFailure,
  listCaldavAccountSources,
  readAccountMetadata,
  readCaldavPassword,
  setCaldavAuthFailure,
  transportForAccount,
  type CaldavTransportDeps
} from './caldav-accounts'
import {
  classifyCaldavFailure,
  fetchCollectionCtag,
  fetchObjects,
  listObjectEtags,
  queryObjectsInWindow,
  syncCollectionChanges,
  type CaldavObject
} from './caldav-client'
import {
  expandObject,
  knownObjectEtags,
  removeObjectInstances,
  removeUnseenObjects,
  replaceObjectInstances
} from './caldav-mirror'
import type { CaldavTransport } from './caldav-transport'

const log = createLogger('Calendar:CaldavSync')

const DAY_MS = 24 * 60 * 60 * 1000
// Same span the Google and ICS mirrors cover.
const WINDOW_PAST_MS = 90 * DAY_MS
const WINDOW_FUTURE_MS = 365 * DAY_MS

export interface CaldavSyncDeps extends CaldavTransportDeps {
  now?: () => Date
  /**
   * Handles an object a Memry item is bound to (write-back, #1400). Read-only
   * CalDAV leaves this unset and such objects are simply not mirrored.
   */
  applyBoundObject?: (
    db: DataDb,
    source: CalendarSource,
    object: CaldavObject | { href: string; deleted: true }
  ) => Promise<boolean>
}

export interface CaldavSourceSyncResult {
  mode: 'full' | 'sync-token' | 'ctag' | 'unchanged'
  changedRows: number
}

function windowAt(now: Date): { startAt: string; endAt: string } {
  return {
    startAt: new Date(now.getTime() - WINDOW_PAST_MS).toISOString(),
    endAt: new Date(now.getTime() + WINDOW_FUTURE_MS).toISOString()
  }
}

/**
 * `sync_cursor` for a CalDAV collection: `sync-token:<token>` when the server
 * speaks RFC 6578, `ctag:<ctag>` otherwise. It sits on the synced source row,
 * which is right because the mirror is synced too (#1391): another device
 * that continues from this cursor already has every event it covers.
 */
type Cursor = { mode: 'sync-token'; token: string } | { mode: 'ctag'; ctag: string } | null

function parseCursor(value: string | null): Cursor {
  if (!value) return null
  if (value.startsWith('sync-token:')) return { mode: 'sync-token', token: value.slice(11) }
  if (value.startsWith('ctag:')) return { mode: 'ctag', ctag: value.slice(5) }
  return null
}

function supportsSyncCollection(source: CalendarSource): boolean {
  return (
    (source.metadata as { supportsSyncCollection?: boolean } | null)?.supportsSyncCollection !==
    false
  )
}

function accountFor(db: DataDb, source: CalendarSource): CalendarSource | null {
  if (!source.accountId) return null
  return (
    listCaldavAccountSources(db).find((account) => account.accountId === source.accountId) ?? null
  )
}

function saveSource(db: DataDb, source: CalendarSource, updates: Partial<CalendarSource>): void {
  const saved = upsertCalendarSource(db, {
    ...source,
    ...updates,
    modifiedAt: new Date().toISOString()
  })
  syncCalendarSourceUpdate(saved.id)
  emitCalendarChanged({ entityType: 'calendar_source', id: saved.id })
}

async function applyObjects(
  db: DataDb,
  source: CalendarSource,
  objects: CaldavObject[],
  window: { startAt: string; endAt: string },
  nowIso: string,
  deps: CaldavSyncDeps
): Promise<number> {
  let changed = 0
  for (const object of objects) {
    if (deps.applyBoundObject && (await deps.applyBoundObject(db, source, object))) continue
    const instances = expandObject(object, window)
    if (!instances) continue
    changed += replaceObjectInstances(db, source, object, instances, nowIso)
  }
  return changed
}

async function applyDeletions(
  db: DataDb,
  source: CalendarSource,
  hrefs: string[],
  deps: CaldavSyncDeps
): Promise<number> {
  let changed = 0
  for (const href of hrefs) {
    if (
      deps.applyBoundObject &&
      (await deps.applyBoundObject(db, source, { href, deleted: true }))
    ) {
      continue
    }
    changed += removeObjectInstances(db, source.id, href)
  }
  return changed
}

async function pullFull(
  db: DataDb,
  source: CalendarSource,
  transport: CaldavTransport,
  window: { startAt: string; endAt: string },
  nowIso: string,
  deps: CaldavSyncDeps
): Promise<{ cursor: string | null; changed: number }> {
  // The cursor is read before the objects, so a change landing in between is
  // reported again next time rather than lost.
  let cursor: string | null
  if (supportsSyncCollection(source)) {
    const listing = await syncCollectionChanges(source.remoteId, '', transport)
    cursor = listing.syncToken ? `sync-token:${listing.syncToken}` : null
  } else {
    const ctag = await fetchCollectionCtag(source.remoteId, transport)
    cursor = ctag ? `ctag:${ctag}` : null
  }
  const objects = await queryObjectsInWindow(source.remoteId, window, transport)
  let changed = await applyObjects(db, source, objects, window, nowIso, deps)
  changed += removeUnseenObjects(
    db,
    source.id,
    new Set(objects.map((object) => object.href)),
    window
  )
  return { cursor, changed }
}

async function syncSourceWithTransport(
  db: DataDb,
  source: CalendarSource,
  transport: CaldavTransport,
  deps: CaldavSyncDeps
): Promise<CaldavSourceSyncResult> {
  const now = deps.now?.() ?? new Date()
  const nowIso = now.toISOString()
  const window = windowAt(now)
  const cursor = parseCursor(source.syncCursor ?? null)

  if (!cursor) {
    const { cursor: next, changed } = await pullFull(db, source, transport, window, nowIso, deps)
    saveSource(db, source, {
      syncCursor: next,
      syncStatus: 'ok',
      lastSyncedAt: nowIso,
      lastError: null
    })
    if (changed > 0) emitCalendarProjectionChanged(`caldav:${source.id}`)
    return { mode: 'full', changedRows: changed }
  }

  if (cursor.mode === 'sync-token') {
    const changes = await syncCollectionChanges(source.remoteId, cursor.token, transport)
    const known = knownObjectEtags(db, source.id)
    const stale = changes.changed.filter(
      (entry) => !entry.etag || !known.has(entry.href) || known.get(entry.href) !== entry.etag
    )
    const objects = await fetchObjects(
      source.remoteId,
      stale.map((entry) => entry.href),
      transport
    )
    let changed = await applyObjects(db, source, objects, window, nowIso, deps)
    changed += await applyDeletions(db, source, changes.deleted, deps)
    saveSource(db, source, {
      syncCursor: changes.syncToken ? `sync-token:${changes.syncToken}` : source.syncCursor,
      syncStatus: 'ok',
      lastSyncedAt: nowIso,
      lastError: null
    })
    if (changed > 0) emitCalendarProjectionChanged(`caldav:${source.id}`)
    return { mode: 'sync-token', changedRows: changed }
  }

  const ctag = await fetchCollectionCtag(source.remoteId, transport)
  if (ctag && ctag === cursor.ctag) {
    saveSource(db, source, { syncStatus: 'ok', lastSyncedAt: nowIso, lastError: null })
    return { mode: 'unchanged', changedRows: 0 }
  }
  const remote = await listObjectEtags(source.remoteId, transport)
  const known = knownObjectEtags(db, source.id)
  const remoteHrefs = new Set(remote.map((entry) => entry.href))
  const stale = remote.filter(
    (entry) => !known.has(entry.href) || known.get(entry.href) !== entry.etag
  )
  const deleted = [...known.keys()].filter((href) => !remoteHrefs.has(href))
  const objects = await fetchObjects(
    source.remoteId,
    stale.map((entry) => entry.href),
    transport
  )
  let changed = await applyObjects(db, source, objects, window, nowIso, deps)
  changed += await applyDeletions(db, source, deleted, deps)
  saveSource(db, source, {
    syncCursor: ctag ? `ctag:${ctag}` : null,
    syncStatus: 'ok',
    lastSyncedAt: nowIso,
    lastError: null
  })
  if (changed > 0) emitCalendarProjectionChanged(`caldav:${source.id}`)
  return { mode: 'ctag', changedRows: changed }
}

function recordFailure(db: DataDb, source: CalendarSource, error: ProviderError | Error): void {
  const fresh = getCalendarSourceById(db, source.id) ?? source
  saveSource(db, fresh, {
    syncStatus: 'error',
    lastError: (error instanceof ProviderAuthError ? 'reconnect_required' : error.message).slice(
      0,
      200
    )
  })
}

/**
 * Pull one CalDAV calendar into the mirror. An invalid sync token clears the
 * cursor and pulls in full (`ProviderGoneError`, the same as Google's 410). A
 * rejected password marks the account `reconnect_required` on this device.
 */
export async function syncCaldavCalendarSource(
  db: DataDb,
  sourceId: string,
  deps: CaldavSyncDeps = {}
): Promise<CaldavSourceSyncResult> {
  const source = getCalendarSourceById(db, sourceId)
  if (!source || source.provider !== CALDAV || source.kind !== 'calendar') {
    throw new Error(`CalDAV calendar not found: ${sourceId}`)
  }
  const account = accountFor(db, source)
  if (!account?.accountId) throw new Error(`CalDAV account not found for ${sourceId}`)
  const transport = await transportForAccount(account, deps)
  if (!transport) {
    throw new ProviderAuthError(CALDAV, 'No app password for this CalDAV account on this device')
  }

  try {
    const result = await pullWithCursorReset(db, CALDAV, source, (current) =>
      syncSourceWithTransport(db, current, transport, deps)
    )
    setCaldavAuthFailure(db, account.accountId, false)
    return result
  } catch (error) {
    const mapped = classifyCaldavFailure(error, transport)
    if (mapped instanceof ProviderAuthError) setCaldavAuthFailure(db, account.accountId, true)
    recordFailure(db, source, mapped ?? (error instanceof Error ? error : new Error(String(error))))
    throw mapped ?? error
  }
}

export function listSelectedCaldavCalendars(db: DataDb, accountId?: string): CalendarSource[] {
  return db
    .select()
    .from(calendarSources)
    .where(
      and(
        eq(calendarSources.provider, CALDAV),
        eq(calendarSources.kind, 'calendar'),
        eq(calendarSources.isSelected, true),
        isNull(calendarSources.archivedAt)
      )
    )
    .all()
    .filter((source) => !accountId || source.accountId === accountId)
}

/**
 * One pass over every CalDAV account this device can sync. Accounts are
 * independent: each runs in its own exclusive slot (#1393), so one slow or
 * failing server never blocks another, and an account already syncing is
 * skipped rather than run twice. A server that rate-limits reports
 * `retryAfterMs` so the runner backs off.
 */
export async function syncCaldavNow(
  db: DataDb,
  deps: CaldavSyncDeps & { accountId?: string } = {}
): Promise<{ synced: number; failed: number; retryAfterMs?: number }> {
  const accounts = listCaldavAccountSources(db).filter(
    (account) =>
      account.accountId &&
      (!deps.accountId || account.accountId === deps.accountId) &&
      readAccountMetadata(account)
  )

  const outcomes = await Promise.all(
    accounts.map(async (account) => {
      const accountId = account.accountId as string
      // Another device's account: the mirror arrives through sync, and this
      // device has no password to pull with.
      if (!(await readCaldavPassword(accountId))) {
        return { synced: 0, failed: 0, retryAfterMs: undefined }
      }
      const outcome = await runExclusive(`${CALDAV}:${accountId}`, async () => {
        let synced = 0
        let failed = 0
        let retryAfterMs: number | undefined
        for (const source of listSelectedCaldavCalendars(db, accountId)) {
          try {
            await syncCaldavCalendarSource(db, source.id, deps)
            synced += 1
          } catch (error) {
            failed += 1
            log.warn('CalDAV calendar sync failed', {
              sourceId: source.id,
              kind: error instanceof Error ? error.name : 'unknown'
            })
            if (error instanceof ProviderRateLimitError) {
              retryAfterMs = Math.max(retryAfterMs ?? 0, error.retryAfterMs)
              break
            }
            // A rejected password fails every calendar the same way; stop.
            if (error instanceof ProviderAuthError || hasCaldavAuthFailure(db, accountId)) break
          }
        }
        return { synced, failed, retryAfterMs }
      })
      return outcome ?? { synced: 0, failed: 0, retryAfterMs: undefined }
    })
  )
  const retryAfter = Math.max(0, ...outcomes.map((outcome) => outcome.retryAfterMs ?? 0))
  return {
    synced: outcomes.reduce((total, outcome) => total + outcome.synced, 0),
    failed: outcomes.reduce((total, outcome) => total + outcome.failed, 0),
    ...(retryAfter > 0 ? { retryAfterMs: retryAfter } : {})
  }
}
