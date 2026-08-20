import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { calendarBindings } from '@memry/db-schema/schema/calendar-bindings'
import { calendarExternalEvents } from '@memry/db-schema/schema/calendar-external-events'
import { calendarSources } from '@memry/db-schema/schema/calendar-sources'
import {
  CalendarBindingSyncPayloadSchema,
  CalendarSourceSyncPayloadSchema
} from '@memry/contracts/sync-payloads'
import {
  asClientDb,
  createTestDataDb,
  type TestDatabaseResult,
  type TestDb
} from '@tests/utils/test-db'
import { listCalendarSources } from '../calendar/repositories/calendar-sources-repository'
import { calendarBindingHandler } from './item-handlers/calendar-binding-handler'
import { calendarSourceHandler } from './item-handlers/calendar-source-handler'
import { calendarExternalEventHandler } from './item-handlers/calendar-external-event-handler'
import type { ApplyContext, DrizzleDb } from './item-handlers/types'

vi.mock('../lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

/**
 * Cross-version compatibility for multi-provider calendar (#1396).
 *
 * The scenario: device A runs a build that can connect ICS / CalDAV / Outlook
 * and creates sources with those provider ids. Device B is still on a build
 * that only knows Google, and pulls those rows down.
 *
 * The item handlers were already defensive in the *other* direction — an
 * absent `provider` falls back to `'google'` — but this direction had never
 * been verified. The failure that would matter is not "B cannot use the
 * calendar"; it is B deciding the row is corrupt and cleaning it up, which
 * would remotely delete the connection the user just made on A.
 *
 * These tests exercise the old client's semantics directly: the handlers are
 * provider-blind, so running them against `ics` / `caldav` / `microsoft` rows
 * is exactly what a Google-only build does with them.
 */

const UNKNOWN_PROVIDERS = ['ics', 'caldav', 'microsoft'] as const

function makeCtx(testDb: TestDatabaseResult): ApplyContext {
  return {
    db: testDb.db as unknown as DrizzleDb,
    emit: vi.fn()
  }
}

function sourcePayload(provider: string): Record<string, unknown> {
  return {
    provider,
    kind: 'calendar',
    accountId: 'someone@example.com',
    remoteId: `${provider}-remote-1`,
    title: `${provider} calendar`,
    timezone: 'UTC',
    color: '#2563eb',
    isPrimary: true,
    isSelected: true,
    isMemryManaged: false,
    syncCursor: 'cursor-1',
    syncStatus: 'ok',
    lastSyncedAt: '2026-04-12T08:00:00.000Z',
    metadata: { url: 'https://example.com/feed.ics' },
    archivedAt: null,
    createdAt: '2026-04-12T08:00:00.000Z',
    modifiedAt: '2026-04-12T08:00:00.000Z'
  }
}

describe('cross-version compat: non-Google calendar sources over sync (#1396)', () => {
  let testDb: TestDatabaseResult
  let db: TestDb
  let ctx: ApplyContext

  beforeEach(() => {
    testDb = createTestDataDb()
    db = testDb.db
    ctx = makeCtx(testDb)
  })

  afterEach(() => {
    testDb.close()
  })

  describe('an old client accepts a provider it has never heard of', () => {
    it.each(UNKNOWN_PROVIDERS)('stores a %s source verbatim, not coerced to google', (provider) => {
      const result = calendarSourceHandler.applyUpsert(
        ctx,
        `${provider}-calendar:remote-1`,
        sourcePayload(provider),
        { 'device-a': 1 }
      )

      expect(result).toBe('applied')
      const row = db
        .select()
        .from(calendarSources)
        .where(eq(calendarSources.id, `${provider}-calendar:remote-1`))
        .get()
      expect(row?.provider).toBe(provider)
      // The `?? 'google'` fallback exists for payloads that omit the field.
      // A payload that carries one must never be rewritten.
      expect(row?.provider).not.toBe('google')
    })

    it.each(UNKNOWN_PROVIDERS)(
      'leaves a %s source unarchived and undeleted after it lands',
      (provider) => {
        const id = `${provider}-calendar:remote-1`
        calendarSourceHandler.applyUpsert(ctx, id, sourcePayload(provider), { 'device-a': 1 })

        const row = db.select().from(calendarSources).where(eq(calendarSources.id, id)).get()

        expect(row).toBeDefined()
        expect(row?.archivedAt).toBeNull()
        // Still visible to every read path, which filters on `archivedAt IS NULL`.
        expect(listCalendarSources(asClientDb(db), { provider }).map((s) => s.id)).toEqual([id])
      }
    )

    it('does not "repair" an unknown provider on a second pull', () => {
      const id = 'caldav-calendar:remote-1'
      calendarSourceHandler.applyUpsert(ctx, id, sourcePayload('caldav'), { 'device-a': 1 })
      // Device A edits the title; the row arrives again with the same provider.
      calendarSourceHandler.applyUpsert(
        ctx,
        id,
        { ...sourcePayload('caldav'), title: 'Renamed', modifiedAt: '2026-04-13T08:00:00.000Z' },
        { 'device-a': 2 }
      )

      const row = db.select().from(calendarSources).where(eq(calendarSources.id, id)).get()
      expect(row?.provider).toBe('caldav')
      expect(row?.title).toBe('Renamed')
      expect(row?.archivedAt).toBeNull()
    })

    it('never writes an unknown-provider source back out with a rewritten provider', () => {
      const id = 'ics-calendar:remote-1'
      calendarSourceHandler.applyUpsert(ctx, id, sourcePayload('ics'), { 'device-a': 1 })

      const pushed = calendarSourceHandler.buildPushPayload(db as unknown as DrizzleDb, id)

      expect(pushed).not.toBeNull()
      expect(JSON.parse(pushed as string)).toMatchObject({ provider: 'ics' })
    })
  })

  describe('bindings and external events follow the same rule', () => {
    it.each(UNKNOWN_PROVIDERS)('stores a %s binding verbatim', (provider) => {
      const result = calendarBindingHandler.applyUpsert(
        ctx,
        `calendar_binding:${provider}:event:event-1`,
        {
          sourceType: 'event',
          sourceId: 'event-1',
          provider,
          remoteCalendarId: 'remote-cal',
          remoteEventId: 'remote-event',
          ownershipMode: 'memry_managed',
          writebackMode: 'broad',
          createdAt: '2026-04-12T08:00:00.000Z',
          modifiedAt: '2026-04-12T08:00:00.000Z'
        },
        { 'device-a': 1 }
      )

      expect(result).toBe('applied')
      const row = db
        .select()
        .from(calendarBindings)
        .where(eq(calendarBindings.id, `calendar_binding:${provider}:event:event-1`))
        .get()
      expect(row?.provider).toBe(provider)
      expect(row?.archivedAt).toBeNull()
    })

    it('accepts an external event whose parent source is an unknown provider', () => {
      const sourceId = 'caldav-calendar:remote-1'
      calendarSourceHandler.applyUpsert(ctx, sourceId, sourcePayload('caldav'), { 'device-a': 1 })

      const result = calendarExternalEventHandler.applyUpsert(
        ctx,
        'calendar_external_event:caldav:remote-event-1',
        {
          sourceId,
          remoteEventId: 'remote-event-1',
          title: 'Standup',
          startAt: '2026-04-14T09:00:00.000Z',
          endAt: '2026-04-14T09:15:00.000Z',
          isAllDay: false,
          timezone: 'UTC',
          status: 'confirmed',
          createdAt: '2026-04-12T08:00:00.000Z',
          modifiedAt: '2026-04-12T08:00:00.000Z'
        },
        { 'device-a': 1 }
      )

      expect(result).toBe('applied')
      // The parent-source guard (#837) is keyed on the row existing, not on
      // the provider being one this build can sync.
      expect(db.select().from(calendarExternalEvents).all()).toHaveLength(1)
    })
  })

  describe('the payload round trip keeps the provider', () => {
    it.each(UNKNOWN_PROVIDERS)('survives schema parse for %s sources', (provider) => {
      const parsed = CalendarSourceSyncPayloadSchema.parse(sourcePayload(provider))

      // `provider` is `z.string().optional()`, not an enum — an old client's
      // zod must not strip a value it does not recognise, because a stripped
      // field would come back as the `?? 'google'` fallback and silently
      // re-home the calendar.
      expect(parsed.provider).toBe(provider)
    })

    it.each(UNKNOWN_PROVIDERS)('survives schema parse for %s bindings', (provider) => {
      const parsed = CalendarBindingSyncPayloadSchema.parse({
        sourceType: 'event',
        sourceId: 'event-1',
        provider,
        remoteCalendarId: 'remote-cal',
        remoteEventId: 'remote-event'
      })

      expect(parsed.provider).toBe(provider)
    })

    it('survives the full local → push payload → remote apply loop', () => {
      const id = 'microsoft-calendar:remote-1'
      calendarSourceHandler.applyUpsert(ctx, id, sourcePayload('microsoft'), { 'device-a': 1 })

      // What device A ships…
      const pushed = calendarSourceHandler.buildPushPayload(db as unknown as DrizzleDb, id)
      const decoded = CalendarSourceSyncPayloadSchema.parse(JSON.parse(pushed as string))

      // …applied on a second device, exactly as the pull path does it.
      const other = createTestDataDb()
      try {
        const otherCtx = makeCtx(other)
        calendarSourceHandler.applyUpsert(otherCtx, id, decoded, { 'device-a': 1 })
        const row = other.db.select().from(calendarSources).where(eq(calendarSources.id, id)).get()
        expect(row?.provider).toBe('microsoft')
        expect(row?.metadata).toEqual({ url: 'https://example.com/feed.ics' })
        expect(row?.syncCursor).toBe('cursor-1')
      } finally {
        other.close()
      }
    })
  })

  describe('delete-clock behaviour is provider-independent', () => {
    it.each(UNKNOWN_PROVIDERS)(
      'applies a remote delete for %s exactly as it would for google',
      (provider) => {
        const id = `${provider}-calendar:remote-1`
        calendarSourceHandler.applyUpsert(ctx, id, sourcePayload(provider), { 'device-a': 1 })

        expect(calendarSourceHandler.applyDelete(ctx, id, { 'device-a': 2 })).toBe('applied')
        expect(
          db.select().from(calendarSources).where(eq(calendarSources.id, id)).get()
        ).toBeUndefined()
      }
    )

    it.each(UNKNOWN_PROVIDERS)(
      'skips a stale remote delete for %s when the local copy has unseen changes',
      (provider) => {
        const id = `${provider}-calendar:remote-1`
        calendarSourceHandler.applyUpsert(ctx, id, sourcePayload(provider), { 'device-a': 5 })

        // A tombstone from a device that had not seen the local edits.
        expect(calendarSourceHandler.applyDelete(ctx, id, { 'device-b': 1 })).toBe('skipped')
        expect(
          db.select().from(calendarSources).where(eq(calendarSources.id, id)).get()?.provider
        ).toBe(provider)
      }
    )

    it('applies a google delete and an unknown-provider delete identically', () => {
      calendarSourceHandler.applyUpsert(ctx, 'google-calendar:g', sourcePayload('google'), {
        'device-a': 1
      })
      calendarSourceHandler.applyUpsert(ctx, 'caldav-calendar:c', sourcePayload('caldav'), {
        'device-a': 1
      })

      const googleResult = calendarSourceHandler.applyDelete(ctx, 'google-calendar:g', {
        'device-a': 2
      })
      const caldavResult = calendarSourceHandler.applyDelete(ctx, 'caldav-calendar:c', {
        'device-a': 2
      })

      expect(caldavResult).toBe(googleResult)
      expect(db.select().from(calendarSources).all()).toHaveLength(0)
    })
  })
})
