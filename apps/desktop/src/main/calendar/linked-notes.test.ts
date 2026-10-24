import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTestDatabases, sql, type TestDb } from '@tests/utils/test-db'
import { calendarBindings } from '@memry/db-schema/schema/calendar-bindings'
import { calendarEvents } from '@memry/db-schema/schema/calendar-events'
import { calendarExternalEvents } from '@memry/db-schema/schema/calendar-external-events'
import { calendarSources } from '@memry/db-schema/schema/calendar-sources'
import { encodeExternalEventRelationId, formatRelationUri } from '@memry/contracts/relation-uri'
import type { DataDb, IndexDb } from '../database'
import { setPropertyRefs } from '../database/queries/notes/property-ref-queries'
import { resolveRefs } from '../ipc/relation-handlers'
import { listLinkedNotes } from './linked-notes'

const NOW = '2026-05-01T00:00:00.000Z'
const START = '2026-05-10T09:00:00.000Z'
// A Google mirror the user linked before first opening the event, which then
// promoted it into the native event `evt_g`, and a subscribed-feed mirror.
const GOOGLE_MIRROR = 'calendar_external_event:google-src:g-remote-1'
const ICS_MIRROR =
  'calendar_external_event:ics-calendar:ab12:uid-1@example.com::2026-05-10T09:00:00.000Z'

const eventUri = (id: string): string => formatRelationUri('event', id)
const externalUri = (rowId: string): string =>
  formatRelationUri('external-event', encodeExternalEventRelationId(rowId))

function source(
  id: string,
  provider: string,
  remoteId: string
): typeof calendarSources.$inferInsert {
  return {
    id,
    provider,
    kind: 'calendar',
    remoteId,
    title: id,
    isSelected: true,
    createdAt: NOW,
    modifiedAt: NOW
  }
}

function mirror(
  id: string,
  sourceId: string,
  remoteEventId: string,
  archivedAt: string | null
): typeof calendarExternalEvents.$inferInsert {
  const title = `Mirror ${remoteEventId}`
  return {
    id,
    sourceId,
    remoteEventId,
    title,
    startAt: START,
    archivedAt,
    createdAt: NOW,
    modifiedAt: NOW
  }
}

function insertNote(db: TestDb, id: string, title: string): void {
  db.run(sql`
    INSERT INTO note_cache (id, path, title, file_type, content_hash, word_count, character_count, created_at, modified_at)
    VALUES (${id}, ${`notes/${id}.md`}, ${title}, 'markdown', ${`hash-${id}`}, 0, 0, ${NOW}, ${NOW})
  `)
}

describe('calendar event note links', () => {
  let dataDb: DataDb
  let indexDb: IndexDb
  let closeAll: () => void

  beforeEach(() => {
    const dbs = createTestDatabases()
    dataDb = dbs.data.db as unknown as DataDb
    indexDb = dbs.index.db
    closeAll = dbs.closeAll

    dataDb
      .insert(calendarSources)
      .values([
        source('google-src', 'google', 'work@example.com'),
        source('ics-calendar:ab12', 'ics', 'https://example.com/feed.ics')
      ])
      .run()
    dataDb.insert(calendarEvents).values({ id: 'evt_g', title: 'Planning', startAt: START }).run()
    dataDb
      .insert(calendarExternalEvents)
      .values([
        mirror(GOOGLE_MIRROR, 'google-src', 'g-remote-1', NOW),
        mirror(ICS_MIRROR, 'ics-calendar:ab12', 'uid-1@example.com::2026-05-10T09:00:00.000Z', null)
      ])
      .run()
    dataDb
      .insert(calendarBindings)
      .values({
        id: 'bind-1',
        sourceType: 'event',
        sourceId: 'evt_g',
        provider: 'google',
        remoteCalendarId: 'work@example.com',
        remoteEventId: 'g-remote-1',
        ownershipMode: 'provider_managed',
        writebackMode: 'time_and_text',
        createdAt: NOW,
        modifiedAt: NOW
      })
      .run()

    const notes: Array<[string, string, Record<string, unknown>]> = [
      ['nte_native', 'B agenda', { Event: [eventUri('evt_g')] }],
      ['nte_before_promote', 'A prep', { Event: [externalUri(GOOGLE_MIRROR)] }],
      ['nte_ics', 'Feed note', { Event: [externalUri(ICS_MIRROR), eventUri('evt_other')] }],
      ['nte_unrelated', 'Other', { Related: [eventUri('evt_other')] }]
    ]
    for (const [id, title, properties] of notes) {
      insertNote(dbs.index.db, id, title)
      setPropertyRefs(indexDb, id, properties)
    }
  })

  afterEach(() => closeAll())

  it("lists a native event's notes, including ones linked to the mirror it was promoted from", () => {
    const notes = listLinkedNotes(dataDb, indexDb, { sourceType: 'event', sourceId: 'evt_g' })
    expect(notes.map((note) => note.id)).toEqual(['nte_before_promote', 'nte_native'])
  })

  it("lists a subscribed event's notes by its mirror row id", () => {
    const notes = listLinkedNotes(dataDb, indexDb, {
      sourceType: 'external_event',
      sourceId: ICS_MIRROR
    })
    expect(notes.map((note) => note.id)).toEqual(['nte_ics'])
  })

  it('resolves an external event chip to the calendar item that shows it', async () => {
    const [promoted, subscribed, gone] = await resolveRefs(indexDb, dataDb, [
      externalUri(GOOGLE_MIRROR),
      externalUri(ICS_MIRROR),
      externalUri('calendar_external_event:missing')
    ])
    expect(promoted).toMatchObject({ exists: true, startAt: START, calendarItemId: 'evt_g' })
    expect(subscribed).toMatchObject({
      exists: true,
      title: 'Mirror uid-1@example.com::2026-05-10T09:00:00.000Z',
      calendarItemId: ICS_MIRROR
    })
    expect(gone.exists).toBe(false)
  })
})
