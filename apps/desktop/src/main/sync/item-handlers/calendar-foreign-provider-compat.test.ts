/**
 * #1396: rows from providers other than Google, as the shared
 * `@memry/sync-client` handlers see them when another device writes them.
 * The handlers live in `packages/sync-client`; their SQLite tests live here
 * because only the desktop package ships a SQLite driver.
 */
import { beforeAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import sodium from 'libsodium-wrappers-sumo'
import { calendarBindings } from '@memry/db-schema/schema/calendar-bindings'
import { calendarExternalEvents } from '@memry/db-schema/schema/calendar-external-events'
import { calendarSources } from '@memry/db-schema/schema/calendar-sources'
import { syncQueue } from '@memry/db-schema/schema/sync-queue'
import {
  CalendarBindingSyncPayloadSchema,
  CalendarExternalEventSyncPayloadSchema,
  CalendarSourceSyncPayloadSchema
} from '@memry/contracts/sync-payloads'
import { createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { SyncQueueManager } from '@memry/sync-client/queue'
import { calendarBindingHandler } from '@memry/sync-client/item-handlers/calendar-binding-handler'
import { calendarExternalEventHandler } from '@memry/sync-client/item-handlers/calendar-external-event-handler'
import { calendarSourceHandler } from '@memry/sync-client/item-handlers/calendar-source-handler'
import type { ApplyContext, DrizzleDb } from '@memry/sync-client/item-handlers/types'
import { initCrypto } from '../../crypto/index'
import { encryptItemForPush } from '../encrypt'
import { decryptItemFromPull } from '../decrypt'

vi.mock('../../lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

const FOREIGN_PROVIDERS = ['ics', 'caldav', 'microsoft'] as const
const NOW = '2026-09-24T08:00:00.000Z'

function remoteIds(provider: string): { calendar: string; event: string } {
  return provider === 'caldav'
    ? {
        calendar: 'https://p67-caldav.icloud.com/1234/calendars/work/',
        event: 'https://p67-caldav.icloud.com/1234/calendars/work/abc.ics'
      }
    : { calendar: `${provider}-calendar-1`, event: `${provider}-event-1` }
}

describe('foreign-provider calendar rows through the shared sync handlers (#1396)', () => {
  let testDb: TestDatabaseResult
  let ctx: ApplyContext
  let db: DrizzleDb

  beforeAll(async () => {
    await initCrypto()
  })

  beforeEach(() => {
    testDb = createTestDataDb()
    db = testDb.db as unknown as DrizzleDb
    ctx = { db, emit: vi.fn() }
  })

  afterEach(() => {
    testDb.close()
  })

  function applySource(provider: string, clock = { 'device-a': 1 }): string {
    const id = `${provider}-calendar:work`
    expect(
      calendarSourceHandler.applyUpsert(
        ctx,
        id,
        {
          provider,
          kind: 'calendar',
          accountId: provider === 'ics' ? null : `${provider}-account`,
          remoteId: remoteIds(provider).calendar,
          title: 'Work',
          isSelected: true,
          syncCursor: provider === 'caldav' ? 'http://radicale.org/ns/sync/42' : null,
          syncStatus: 'ok',
          createdAt: NOW,
          modifiedAt: NOW
        },
        clock
      )
    ).toBe('applied')
    return id
  }

  describe.each(FOREIGN_PROVIDERS)('provider %s', (provider) => {
    it('stores the source row as sent: not deleted, not archived, not repaired to Google', () => {
      const id = applySource(provider)

      // A later update that omits `provider` keeps it; older payloads do this.
      calendarSourceHandler.applyUpsert(ctx, id, { title: 'Work (renamed)' }, { 'device-a': 2 })

      const row = db.select().from(calendarSources).where(eq(calendarSources.id, id)).get()
      expect(row).toMatchObject({
        provider,
        remoteId: remoteIds(provider).calendar,
        title: 'Work (renamed)',
        isSelected: true,
        archivedAt: null,
        clock: { 'device-a': 2 }
      })
    })

    it('stores a binding untouched', () => {
      const bindingId = `calendar_binding:${provider}:task:task-1`
      expect(
        calendarBindingHandler.applyUpsert(
          ctx,
          bindingId,
          {
            sourceType: 'task',
            sourceId: 'task-1',
            provider,
            remoteCalendarId: remoteIds(provider).calendar,
            remoteEventId: remoteIds(provider).event,
            ownershipMode: 'memry_managed',
            writebackMode: 'broad',
            remoteVersion: '"etag-7"',
            createdAt: NOW,
            modifiedAt: NOW
          },
          { 'device-a': 1 }
        )
      ).toBe('applied')

      expect(
        db.select().from(calendarBindings).where(eq(calendarBindings.id, bindingId)).get()
      ).toMatchObject({
        provider,
        remoteCalendarId: remoteIds(provider).calendar,
        remoteEventId: remoteIds(provider).event,
        remoteVersion: '"etag-7"',
        archivedAt: null,
        clock: { 'device-a': 1 }
      })
    })

    it('stores an external event with its clock intact', () => {
      const sourceId = applySource(provider)
      const eventId = `calendar_external_event:${sourceId}:1`
      expect(
        calendarExternalEventHandler.applyUpsert(
          ctx,
          eventId,
          {
            sourceId,
            remoteEventId: remoteIds(provider).event,
            remoteEtag: '"etag-1"',
            title: 'Standup',
            startAt: '2026-09-25T09:00:00.000Z',
            endAt: '2026-09-25T09:30:00.000Z',
            isAllDay: false,
            status: 'confirmed',
            rawPayload: { ical: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n', etag: '"etag-1"' },
            createdAt: NOW,
            modifiedAt: NOW
          },
          { 'device-a': 3, 'device-b': 1 }
        )
      ).toBe('applied')

      expect(
        db.select().from(calendarExternalEvents).where(eq(calendarExternalEvents.id, eventId)).get()
      ).toMatchObject({
        sourceId,
        remoteEventId: remoteIds(provider).event,
        clock: { 'device-a': 3, 'device-b': 1 },
        archivedAt: null
      })
    })

    it('keeps `provider` through the encrypted payload round trip', () => {
      const sourceId = applySource(provider)
      const payload = calendarSourceHandler.buildPushPayload(db, sourceId)
      expect(payload).not.toBeNull()

      const keyPair = sodium.crypto_sign_keypair()
      const vaultKey = sodium.randombytes_buf(32)
      const { pushItem } = encryptItemForPush({
        id: sourceId,
        type: 'calendar_source',
        operation: 'update',
        content: new TextEncoder().encode(payload!),
        vaultKey,
        signingSecretKey: keyPair.privateKey,
        signerDeviceId: 'device-a',
        clock: { 'device-a': 1 }
      })
      const { content } = decryptItemFromPull({
        id: pushItem.id,
        type: pushItem.type,
        operation: pushItem.operation,
        cryptoVersion: 1,
        encryptedKey: pushItem.encryptedKey,
        keyNonce: pushItem.keyNonce,
        encryptedData: pushItem.encryptedData,
        dataNonce: pushItem.dataNonce,
        signature: pushItem.signature,
        signerDeviceId: pushItem.signerDeviceId,
        metadata: { clock: pushItem.clock },
        vaultKey,
        signerPublicKey: keyPair.publicKey
      })
      const decoded = JSON.parse(new TextDecoder().decode(content)) as unknown
      const parsed = CalendarSourceSyncPayloadSchema.parse(decoded)
      expect(parsed.provider).toBe(provider)
      expect(parsed.remoteId).toBe(remoteIds(provider).calendar)

      // Applied on a fresh device, the row lands under the same provider.
      testDb.close()
      testDb = createTestDataDb()
      db = testDb.db as unknown as DrizzleDb
      ctx = { db, emit: vi.fn() }
      calendarSourceHandler.applyUpsert(ctx, sourceId, parsed, parsed.clock ?? {})
      expect(
        db.select().from(calendarSources).where(eq(calendarSources.id, sourceId)).get()?.provider
      ).toBe(provider)
    })

    it('resolves deletes by vector clock exactly as it does for Google', () => {
      const foreign = applySource(provider, { 'device-a': 5 })
      const google = applySource('google', { 'device-a': 5 })

      // A tombstone behind the local clock is skipped for both providers ...
      expect(calendarSourceHandler.applyDelete(ctx, foreign, { 'device-a': 4 })).toBe(
        calendarSourceHandler.applyDelete(ctx, google, { 'device-a': 4 })
      )
      // ... and one at or past it is applied for both.
      expect(calendarSourceHandler.applyDelete(ctx, foreign, { 'device-a': 6 })).toBe('applied')
      expect(calendarSourceHandler.applyDelete(ctx, google, { 'device-a': 6 })).toBe('applied')

      const bindingPayload = {
        sourceType: 'event' as const,
        sourceId: 'event-1',
        remoteCalendarId: 'cal',
        remoteEventId: 'evt',
        createdAt: NOW,
        modifiedAt: NOW
      }
      calendarBindingHandler.applyUpsert(
        ctx,
        'b-foreign',
        { ...bindingPayload, provider },
        { 'device-a': 5 }
      )
      calendarBindingHandler.applyUpsert(
        ctx,
        'b-google',
        { ...bindingPayload, provider: 'google', remoteEventId: 'evt-g' },
        { 'device-a': 5 }
      )
      expect(calendarBindingHandler.applyDelete(ctx, 'b-foreign', { 'device-a': 4 })).toBe(
        calendarBindingHandler.applyDelete(ctx, 'b-google', { 'device-a': 4 })
      )
      expect(calendarBindingHandler.applyDelete(ctx, 'b-foreign', { 'device-a': 6 })).toBe(
        calendarBindingHandler.applyDelete(ctx, 'b-google', { 'device-a': 6 })
      )
    })
  })

  it('binding and external-event payloads carry provider-specific ids unchanged', () => {
    const sourceId = applySource('caldav')
    calendarBindingHandler.applyUpsert(
      ctx,
      'b-caldav',
      {
        sourceType: 'event',
        sourceId: 'event-1',
        provider: 'caldav',
        remoteCalendarId: remoteIds('caldav').calendar,
        remoteEventId: remoteIds('caldav').event,
        remoteVersion: '"etag-2"',
        createdAt: NOW,
        modifiedAt: NOW
      },
      { 'device-a': 1 }
    )
    const binding = CalendarBindingSyncPayloadSchema.parse(
      JSON.parse(calendarBindingHandler.buildPushPayload(db, 'b-caldav')!)
    )
    expect(binding).toMatchObject({
      provider: 'caldav',
      remoteCalendarId: remoteIds('caldav').calendar,
      remoteEventId: remoteIds('caldav').event,
      remoteVersion: '"etag-2"'
    })

    calendarExternalEventHandler.applyUpsert(
      ctx,
      'ext-caldav',
      {
        sourceId,
        remoteEventId: remoteIds('caldav').event,
        title: 'Standup',
        startAt: '2026-09-25T09:00:00.000Z',
        isAllDay: false,
        status: 'confirmed',
        createdAt: NOW,
        modifiedAt: NOW
      },
      { 'device-a': 1 }
    )
    const external = CalendarExternalEventSyncPayloadSchema.parse(
      JSON.parse(calendarExternalEventHandler.buildPushPayload(db, 'ext-caldav')!)
    )
    expect(external.remoteEventId).toBe(remoteIds('caldav').event)
  })

  it('the unclocked sweep pushes a synced mirror (caldav) but never a device-local one (ics)', () => {
    const queue = new SyncQueueManager(db)
    for (const provider of ['caldav', 'ics']) {
      db.insert(calendarSources)
        .values({
          id: `${provider}-src`,
          provider,
          kind: 'calendar',
          remoteId: `${provider}-remote`,
          title: provider,
          syncStatus: 'ok',
          createdAt: NOW,
          modifiedAt: NOW
        })
        .run()
      db.insert(calendarExternalEvents)
        .values({
          id: `${provider}-evt`,
          sourceId: `${provider}-src`,
          remoteEventId: `${provider}-remote-evt`,
          title: 'Unclocked',
          startAt: NOW,
          isAllDay: false,
          status: 'confirmed',
          createdAt: NOW,
          modifiedAt: NOW
        })
        .run()
    }

    expect(calendarExternalEventHandler.seedUnclocked(db, 'device-a', queue)).toBe(1)
    // Source rows sync for both: an ICS subscription travels, its events do not.
    expect(calendarSourceHandler.seedUnclocked(db, 'device-a', queue)).toBe(2)

    const queued = db.select().from(syncQueue).all()
    expect(
      queued.filter((item) => item.type === 'calendar_external_event').map((i) => i.itemId)
    ).toEqual(['caldav-evt'])
    expect(
      db.select().from(calendarExternalEvents).where(eq(calendarExternalEvents.id, 'ics-evt')).get()
        ?.clock
    ).toBeNull()
  })
})
