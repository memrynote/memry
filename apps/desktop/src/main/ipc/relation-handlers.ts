/**
 * Relation Property Resolution IPC
 *
 * Resolves `memry://<kind>/<id>` relation property URIs to display data
 * (title, existence) for chip rendering in the renderer. Spans both
 * databases: note targets live in `note_cache` (index DB), task and event
 * targets live in `tasks` / `calendar_events` (data DB). Canvas targets live in
 * `canvases` (data DB) and journal targets are `note_cache` rows with a `date`
 * (index DB). External provider events live in `calendar_external_events`
 * (data DB), addressed by their base64url-encoded row id.
 *
 * @module ipc/relation-handlers
 */

import { ipcMain } from 'electron'
import { and, inArray, isNull } from 'drizzle-orm'
import { noteCache } from '@memry/db-schema/schema/notes-cache'
import { tasks } from '@memry/db-schema/schema/tasks'
import { calendarEvents } from '@memry/db-schema/schema/calendar-events'
import { canvases } from '@memry/db-schema/schema/canvas'
import { calendarExternalEvents } from '@memry/db-schema/schema/calendar-external-events'
import {
  PropertiesChannels,
  ResolveRefsSchema,
  type ResolvedRelationRef
} from '@memry/contracts/properties-api'
import {
  decodeExternalEventRelationId,
  parseRelationUri,
  type RelationKind
} from '@memry/contracts/relation-uri'
import {
  findCalendarBindingByRemoteEvent,
  getCalendarSourceById
} from '../calendar/repositories/calendar-sources-repository'
import { getDatabase, getIndexDatabase, type DataDb, type IndexDb } from '../database'
import { createLogger } from '../lib/logger'
import { createValidatedHandler } from './validate'

const logger = createLogger('RelationRefs')

/**
 * Resolve a batch of relation URIs to display data.
 *
 * Groups the parsed URIs by kind and issues at most one `inArray` query per
 * kind (one per kind, regardless of how many URIs come in) rather than one
 * query per URI. The result preserves the order and length of the input
 * array. Malformed or missing targets never throw — they come back as
 * `exists: false` so a bad ref can't blank the property row.
 */
export async function resolveRefs(
  indexDb: IndexDb,
  dataDb: DataDb,
  uris: string[]
): Promise<ResolvedRelationRef[]> {
  const parsed = uris.map((uri) => parseRelationUri(uri))

  const idsByKind: Record<RelationKind, string[]> = {
    note: [],
    task: [],
    event: [],
    'external-event': [],
    canvas: [],
    journal: []
  }
  for (const ref of parsed) {
    if (ref) idsByKind[ref.kind].push(ref.id)
  }

  const noteRows = idsByKind.note.length
    ? indexDb
        .select({
          id: noteCache.id,
          title: noteCache.title,
          fileType: noteCache.fileType,
          emoji: noteCache.emoji
        })
        .from(noteCache)
        .where(inArray(noteCache.id, idsByKind.note))
        .all()
    : []
  const taskRows = idsByKind.task.length
    ? dataDb
        .select({ id: tasks.id, title: tasks.title, projectId: tasks.projectId })
        .from(tasks)
        .where(inArray(tasks.id, idsByKind.task))
        .all()
    : []
  const eventRows = idsByKind.event.length
    ? dataDb
        .select({
          id: calendarEvents.id,
          title: calendarEvents.title,
          startAt: calendarEvents.startAt
        })
        .from(calendarEvents)
        .where(inArray(calendarEvents.id, idsByKind.event))
        .all()
    : []
  // Archived rows included: promotion archives the mirror it copied, and the
  // link still names that event.
  const externalRowIds = idsByKind['external-event'].flatMap(
    (id) => decodeExternalEventRelationId(id) ?? []
  )
  const externalRows = externalRowIds.length
    ? dataDb
        .select()
        .from(calendarExternalEvents)
        .where(inArray(calendarExternalEvents.id, externalRowIds))
        .all()
    : []
  // A soft-deleted canvas is a dangling target, not a hit: `deletedAt` is the
  // tombstone sync relies on, so the row is still there and must be filtered.
  const canvasRows = idsByKind.canvas.length
    ? dataDb
        .select({ id: canvases.id, title: canvases.title })
        .from(canvases)
        .where(and(inArray(canvases.id, idsByKind.canvas), isNull(canvases.deletedAt)))
        .all()
    : []
  // Journal entries are `note_cache` rows carrying a `date`; the date IS the
  // identity, so the lookup is by date rather than by row id.
  const journalRows = idsByKind.journal.length
    ? indexDb
        .select({ id: noteCache.id, title: noteCache.title, date: noteCache.date })
        .from(noteCache)
        .where(inArray(noteCache.date, idsByKind.journal))
        .all()
    : []

  const noteById = new Map(noteRows.map((row) => [row.id, row]))
  const taskById = new Map(taskRows.map((row) => [row.id, row]))
  const eventById = new Map(eventRows.map((row) => [row.id, row]))
  const canvasById = new Map(canvasRows.map((row) => [row.id, row]))
  const externalById = new Map(externalRows.map((row) => [row.id, row]))
  // Two notes can in principle claim the same journal date; first row wins, the
  // same way every other journal-by-date read in the app resolves it.
  const journalByDate = new Map<string, (typeof journalRows)[number]>()
  for (const row of journalRows) {
    if (row.date && !journalByDate.has(row.date)) journalByDate.set(row.date, row)
  }

  return uris.map((uri, index) => {
    const ref = parsed[index]
    if (!ref) {
      logger.warn('malformed relation URI', { uri })
      return { uri, targetType: 'note', targetId: '', title: '', exists: false }
    }

    if (ref.kind === 'note') {
      const note = noteById.get(ref.id)
      if (!note) return { uri, targetType: 'note', targetId: ref.id, title: '', exists: false }
      return {
        uri,
        targetType: 'note',
        targetId: ref.id,
        title: note.title,
        exists: true,
        ...(note.fileType !== 'markdown' ? { fileType: note.fileType } : {}),
        ...(note.emoji ? { emoji: note.emoji } : {})
      }
    }

    if (ref.kind === 'task') {
      const task = taskById.get(ref.id)
      if (!task) return { uri, targetType: 'task', targetId: ref.id, title: '', exists: false }
      return {
        uri,
        targetType: 'task',
        targetId: ref.id,
        title: task.title,
        exists: true,
        ...(task.projectId ? { projectId: task.projectId } : {})
      }
    }

    if (ref.kind === 'canvas') {
      const canvas = canvasById.get(ref.id)
      if (!canvas) return { uri, targetType: 'canvas', targetId: ref.id, title: '', exists: false }
      return {
        uri,
        targetType: 'canvas',
        targetId: ref.id,
        title: canvas.title ?? '',
        exists: true
      }
    }

    if (ref.kind === 'journal') {
      const journal = journalByDate.get(ref.id)
      if (!journal) {
        return { uri, targetType: 'journal', targetId: ref.id, title: '', exists: false }
      }
      return {
        uri,
        targetType: 'journal',
        targetId: ref.id,
        // The date is the chip's most useful label; the note title for a
        // journal entry is usually the date anyway.
        title: journal.title || ref.id,
        exists: true,
        date: ref.id
      }
    }

    if (ref.kind === 'external-event') {
      const rowId = decodeExternalEventRelationId(ref.id)
      const row = rowId ? externalById.get(rowId) : undefined
      if (!row) {
        return { uri, targetType: 'external-event', targetId: ref.id, title: '', exists: false }
      }
      return {
        uri,
        targetType: 'external-event',
        targetId: ref.id,
        title: row.title,
        exists: true,
        startAt: row.startAt,
        calendarItemId: row.archivedAt ? (promotedEventId(dataDb, row) ?? row.id) : row.id
      }
    }

    const event = eventById.get(ref.id)
    if (!event) return { uri, targetType: 'event', targetId: ref.id, title: '', exists: false }
    return {
      uri,
      targetType: 'event',
      targetId: ref.id,
      title: event.title,
      exists: true,
      startAt: event.startAt,
      calendarItemId: ref.id
    }
  })
}

/** The native event an archived mirror was promoted into, if any. */
function promotedEventId(
  dataDb: DataDb,
  row: typeof calendarExternalEvents.$inferSelect
): string | null {
  const source = getCalendarSourceById(dataDb, row.sourceId)
  if (!source) return null
  const binding = findCalendarBindingByRemoteEvent(
    dataDb,
    source.provider,
    source.remoteId,
    row.remoteEventId
  )
  return binding?.sourceType === 'event' ? binding.sourceId : null
}

/**
 * Register relation-resolution IPC handlers.
 * Call this once during app initialization.
 */
export function registerRelationHandlers(): void {
  ipcMain.handle(
    PropertiesChannels.invoke.RESOLVE_REFS,
    createValidatedHandler(ResolveRefsSchema, async (input): Promise<ResolvedRelationRef[]> => {
      const indexDb = getIndexDatabase()
      const dataDb = getDatabase()
      return resolveRefs(indexDb, dataDb, input.uris)
    })
  )
}

/**
 * Unregister relation-resolution IPC handlers.
 * Useful for cleanup or testing.
 */
export function unregisterRelationHandlers(): void {
  ipcMain.removeHandler(PropertiesChannels.invoke.RESOLVE_REFS)
}
