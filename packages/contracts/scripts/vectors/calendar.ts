/**
 * Class: calendar (`calendar.json`, spec 007 CL011-CL013).
 *
 * Three sections, each desktop's behaviour restated line for line from the
 * source it names (the handlers and the projection need desktop's Electron
 * database and cannot be imported here; `mergeFields` and the colour tables
 * are imported for real).
 *
 * - `apply`: payload sequences through the four handlers
 *   (`packages/sync-client/src/item-handlers/calendar-{source,binding,
 *   external-event}-handler.ts`, `apps/desktop/src/main/sync/item-handlers/
 *   calendar-event-handler.ts`) and the row desktop ends up holding.
 * - `projection`: one set of rows and what `getCalendarRangeProjection`
 *   (`apps/desktop/src/main/calendar/projection.ts`) answers for each query,
 *   run under `TZ=America/New_York` across the November DST change, plus
 *   `filterCalendarItems` (`calendar-search-filter.ts`) over the search range.
 *   The zone is also written out as offset transitions, the shape the phone
 *   passes its core.
 * - `writes`: the record each write emits (`ipc/calendar-handlers.ts`
 *   create / update / delete, `promote-external-event.ts`,
 *   `UPDATE_SOURCE_SELECTION` + `purgeCalendarSourceMirrors`), with the
 *   enqueue's clock step from `calendar-event-sync.ts` /
 *   `RecordSyncController`.
 */
import { mergeFields, initAllFieldClocks } from '../../../sync-client/src/field-merge.ts'
import { compare, increment, merge } from '../../../sync-client/src/vector-clock.ts'
import {
  calendarColorHex,
  calendarDisplayHex,
  calendarEventColorFromColorId,
  colorIdForCalendarEventColor,
  type CalendarEventColor
} from '../../src/calendar-colors'
import {
  CalendarBindingSyncPayloadSchema,
  CalendarEventSyncPayloadSchema,
  CalendarExternalEventSyncPayloadSchema,
  CalendarSourceSyncPayloadSchema
} from '../../src/sync-payloads'
import type { FieldClocks, VectorClock } from '../../src/sync-api'
import {
  APPLY_FIXTURES,
  PROJECTION_QUERIES,
  PROJECTION_ROWS,
  PROJECTION_TIMEZONE,
  SEARCH_QUERIES,
  type ApplyStep
} from './calendar-cases'
import { meta } from './shared'

type Row = Record<string, unknown>

const EVENT_FIELDS = [
  'title',
  'description',
  'location',
  'startAt',
  'endAt',
  'timezone',
  'isAllDay',
  'recurrenceRule',
  'recurrenceExceptions',
  'attendees',
  'reminders',
  'visibility',
  'colorId',
  'conferenceData'
] as const

/** `resolveClockConflict` (`item-handlers/types.ts`). */
function resolve(
  local: VectorClock | null | undefined,
  remote: VectorClock
): { action: 'apply' | 'skip' | 'merge'; mergedClock: VectorClock } {
  if (!local) return { action: 'apply', mergedClock: remote }
  const cmp = compare(local, remote)
  if (cmp === 'after') return { action: 'skip', mergedClock: local }
  if (cmp === 'concurrent') return { action: 'merge', mergedClock: merge(local, remote) }
  return { action: 'apply', mergedClock: remote }
}

const has = (data: Row, key: string): boolean => Object.prototype.hasOwnProperty.call(data, key)
const coalesce = (...values: unknown[]): unknown => {
  for (const v of values) if (v !== undefined && v !== null) return v
  return values[values.length - 1] === undefined ? null : values[values.length - 1]
}

function applySource(existing: Row | null, data: Row, clock: VectorClock): Row | null {
  if (existing) {
    const r = resolve(existing.clock as VectorClock, clock)
    if (r.action === 'skip') return existing
    const keys = [
      'provider',
      'kind',
      'accountId',
      'remoteId',
      'title',
      'timezone',
      'color',
      'isPrimary',
      'isSelected',
      'isMemryManaged',
      'syncCursor',
      'syncStatus',
      'lastSyncedAt',
      'metadata',
      'archivedAt'
    ]
    const next: Row = { ...existing }
    for (const k of keys) next[k] = data[k] ?? existing[k] ?? null
    next.clock = r.mergedClock
    return next
  }
  return {
    provider: data.provider ?? 'google',
    kind: data.kind ?? 'calendar',
    accountId: data.accountId ?? null,
    remoteId: data.remoteId ?? '$id',
    title: data.title ?? 'Untitled calendar',
    timezone: data.timezone ?? null,
    color: data.color ?? null,
    isPrimary: data.isPrimary ?? false,
    isSelected: data.isSelected ?? false,
    isMemryManaged: data.isMemryManaged ?? false,
    syncCursor: data.syncCursor ?? null,
    syncStatus: data.syncStatus ?? 'idle',
    lastSyncedAt: data.lastSyncedAt ?? null,
    metadata: data.metadata ?? null,
    archivedAt: data.archivedAt ?? null,
    clock
  }
}

function applyBinding(existing: Row | null, data: Row, clock: VectorClock): Row | null {
  if (existing) {
    const r = resolve(existing.clock as VectorClock, clock)
    if (r.action === 'skip') return existing
    const keys = [
      'sourceType',
      'sourceId',
      'provider',
      'remoteCalendarId',
      'remoteEventId',
      'ownershipMode',
      'writebackMode',
      'remoteVersion',
      'lastLocalSnapshot',
      'archivedAt'
    ]
    const next: Row = { ...existing }
    for (const k of keys) next[k] = data[k] ?? existing[k] ?? null
    next.clock = r.mergedClock
    return next
  }
  return {
    sourceType: data.sourceType ?? 'event',
    sourceId: data.sourceId ?? '$id',
    provider: data.provider ?? 'google',
    remoteCalendarId: data.remoteCalendarId ?? 'primary',
    remoteEventId: data.remoteEventId ?? '$id',
    ownershipMode: data.ownershipMode ?? 'memry_managed',
    writebackMode: data.writebackMode ?? 'broad',
    remoteVersion: data.remoteVersion ?? null,
    lastLocalSnapshot: data.lastLocalSnapshot ?? null,
    archivedAt: data.archivedAt ?? null,
    clock
  }
}

const EXTERNAL_PRESENCE = ['attendees', 'reminders', 'visibility', 'colorId', 'conferenceData']
const EXTERNAL_KEEP = [
  'sourceId',
  'remoteEventId',
  'remoteEtag',
  'remoteUpdatedAt',
  'title',
  'description',
  'location',
  'startAt',
  'endAt',
  'timezone',
  'isAllDay',
  'status',
  'recurrenceRule',
  'rawPayload',
  'archivedAt'
]

function applyExternal(existing: Row | null, data: Row, clock: VectorClock): Row | null {
  if (existing) {
    const r = resolve(existing.clock as VectorClock, clock)
    if (r.action === 'skip') return existing
    const next: Row = { ...existing }
    for (const k of EXTERNAL_KEEP) next[k] = data[k] ?? existing[k] ?? null
    for (const k of EXTERNAL_PRESENCE)
      next[k] = has(data, k) ? (data[k] ?? null) : (existing[k] ?? null)
    next.clock = r.mergedClock
    return next
  }
  const row: Row = {
    sourceId: data.sourceId ?? '',
    remoteEventId: data.remoteEventId ?? '$id',
    title: data.title ?? 'Untitled imported event',
    isAllDay: data.isAllDay ?? false,
    status: data.status ?? 'confirmed',
    clock
  }
  for (const k of [
    'remoteEtag',
    'remoteUpdatedAt',
    'description',
    'location',
    'endAt',
    'timezone',
    'recurrenceRule',
    'rawPayload',
    'archivedAt',
    ...EXTERNAL_PRESENCE
  ])
    row[k] = data[k] ?? null
  row.startAt = data.startAt ?? '$now'
  return row
}

function applyEvent(existing: Row | null, data: Row, clock: VectorClock): Row | null {
  const remoteFC = (data.fieldClocks as FieldClocks | null | undefined) ?? null
  if (existing) {
    const r = resolve(existing.clock as VectorClock, clock)
    if (r.action === 'skip') return existing
    if (r.action === 'merge') {
      const localFC =
        (existing.fieldClocks as FieldClocks | null) ??
        initAllFieldClocks((existing.clock as VectorClock) ?? {}, EVENT_FIELDS)
      const rfc = remoteFC ?? initAllFieldClocks(clock, EVENT_FIELDS)
      const remoteForMerge: Row = {}
      for (const f of EVENT_FIELDS)
        remoteForMerge[f] = data[f] === undefined ? existing[f] : data[f]
      const result = mergeFields(existing, remoteForMerge, localFC, rfc, EVENT_FIELDS)
      return {
        ...existing,
        ...(result.merged as Row),
        archivedAt: data.archivedAt ?? existing.archivedAt,
        targetCalendarId: has(data, 'targetCalendarId')
          ? (data.targetCalendarId ?? null)
          : (existing.targetCalendarId ?? null),
        parentEventId: has(data, 'parentEventId')
          ? (data.parentEventId ?? null)
          : (existing.parentEventId ?? null),
        originalStartTime: has(data, 'originalStartTime')
          ? (data.originalStartTime ?? null)
          : (existing.originalStartTime ?? null),
        clock: r.mergedClock,
        fieldClocks: result.mergedFieldClocks
      }
    }
    const next: Row = { ...existing }
    for (const k of [
      'title',
      'description',
      'location',
      'startAt',
      'endAt',
      'timezone',
      'isAllDay',
      'recurrenceRule',
      'recurrenceExceptions',
      'archivedAt'
    ])
      next[k] = coalesce(data[k], existing[k])
    for (const k of [
      'attendees',
      'reminders',
      'visibility',
      'colorId',
      'targetCalendarId',
      'parentEventId',
      'originalStartTime',
      'conferenceData'
    ])
      next[k] = has(data, k) ? (data[k] ?? null) : (existing[k] ?? null)
    next.clock = r.mergedClock
    next.fieldClocks = remoteFC ?? initAllFieldClocks(clock, EVENT_FIELDS)
    return next
  }
  const row: Row = {
    title: data.title ?? 'Untitled event',
    startAt: data.startAt ?? '$now',
    timezone: data.timezone ?? 'UTC',
    isAllDay: data.isAllDay ?? false,
    clock,
    fieldClocks: remoteFC ?? initAllFieldClocks(clock, EVENT_FIELDS)
  }
  for (const k of [
    'description',
    'location',
    'endAt',
    'recurrenceRule',
    'recurrenceExceptions',
    'attendees',
    'reminders',
    'visibility',
    'colorId',
    'conferenceData',
    'archivedAt',
    'targetCalendarId',
    'parentEventId',
    'originalStartTime'
  ])
    row[k] = data[k] ?? null
  return row
}

const SCHEMAS = {
  calendar_source: CalendarSourceSyncPayloadSchema,
  calendar_event: CalendarEventSyncPayloadSchema,
  calendar_external_event: CalendarExternalEventSyncPayloadSchema,
  calendar_binding: CalendarBindingSyncPayloadSchema
} as const

const APPLIERS = {
  calendar_source: applySource,
  calendar_event: applyEvent,
  calendar_external_event: applyExternal,
  calendar_binding: applyBinding
} as const

function step(existing: Row | null, s: ApplyStep): Row | null {
  const data = SCHEMAS[s.type].parse(s.payload) as Row
  const clock = (data.clock ?? {}) as VectorClock
  if (s.deleted) {
    if (!existing) return null
    return resolve(existing.clock as VectorClock, clock).action === 'skip' ? existing : null
  }
  return APPLIERS[s.type](existing, data, clock)
}

function buildApply(): Row[] {
  return APPLY_FIXTURES.map((fixture) => {
    let row: Row | null = null
    for (const s of fixture.steps) row = step(row, s)
    if (row) {
      for (const [k, v] of Object.entries(row)) if (v === '$id') row[k] = fixture.id
    }
    return {
      name: fixture.name,
      id: fixture.id,
      type: fixture.steps[0].type,
      steps: fixture.steps,
      expected: row
    }
  })
}

// ---------------------------------------------------------------------------
// Projection, restated from projection.ts over plain rows.
// ---------------------------------------------------------------------------

interface Item extends Row {
  projectionId: string
  startAt: string
}

function preview(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null
  return value.length > 280 ? `${value.slice(0, 277)}...` : value
}

function localDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function localInstant(dateStr: string, timeStr: string | null): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  const [h, min] = (timeStr ?? '00:00').split(':').map(Number)
  return new Date(y, m - 1, d, h, min, 0, 0).toISOString()
}

function localAllDayEnd(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(y, m - 1, d + 1, 0, 0, 0, 0).toISOString()
}

function dayOf(value: string): string | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : localDate(parsed)
}

const native = (title: string): Row => ({
  provider: null,
  calendarSourceId: null,
  title,
  color: null,
  kind: null,
  isMemryManaged: true
})
const EDIT_ALL = { canMove: true, canResize: true, canEditText: true, canDelete: true }
const EDIT_NONE = { canMove: false, canResize: false, canEditText: false, canDelete: false }
const EDIT_MTD = { canMove: true, canResize: false, canEditText: true, canDelete: true }

interface Db {
  sources: Map<string, Row>
  events: Map<string, Row>
  externals: Map<string, Row>
  bindings: Map<string, Row>
  tasks: Map<string, Row>
  reminders: Map<string, Row>
  inbox: Map<string, Row>
  notes: Map<string, Row>
}

function loadDb(): Db {
  const db: Db = {
    sources: new Map(),
    events: new Map(),
    externals: new Map(),
    bindings: new Map(),
    tasks: new Map(),
    reminders: new Map(),
    inbox: new Map(),
    notes: new Map()
  }
  for (const { type, id, payload } of PROJECTION_ROWS) {
    const target = {
      calendar_source: db.sources,
      calendar_event: db.events,
      calendar_external_event: db.externals,
      calendar_binding: db.bindings,
      task: db.tasks,
      reminder: db.reminders,
      inbox: db.inbox,
      note: db.notes
    }[type]
    if (!target) throw new Error(`no table for ${type}`)
    target.set(id, { ...payload, id })
  }
  return db
}

function bindingsFor(db: Db, sourceType: string, ids: string[]): Map<string, Row> {
  const rows = [...db.bindings.values()].filter(
    (b) =>
      (b.sourceType ?? 'event') === sourceType &&
      ids.includes(b.sourceId as string) &&
      !b.archivedAt
  )
  // Desktop's query has no ORDER BY; SQLite returns rowid order, i.e. insert
  // order, and `new Map` keeps the last. The phone orders by `createdAt`, which
  // matches every fixture here (inserted oldest first), so the newest wins.
  return new Map(
    rows.map((b) => [
      b.sourceId as string,
      {
        provider: b.provider ?? 'google',
        remoteCalendarId: b.remoteCalendarId ?? 'primary',
        remoteEventId: b.remoteEventId,
        ownershipMode: b.ownershipMode ?? 'memry_managed',
        writebackMode: b.writebackMode ?? 'broad'
      }
    ])
  )
}

function eventColors(colorId: unknown, calendarHex: string | null | undefined): Row {
  const color = calendarEventColorFromColorId((colorId as string | null) ?? null)
  return { color, displayColor: color ? calendarColorHex(color) : (calendarHex ?? null) }
}

function project(db: Db, q: (typeof PROJECTION_QUERIES)[number]): Item[] {
  const tz = PROJECTION_TIMEZONE
  const items: Item[] = []
  const googleColors = new Map<string, string>()
  for (const s of db.sources.values()) {
    const hex = calendarDisplayHex(s.color as string | null)
    if (
      (s.provider ?? 'google') === 'google' &&
      (s.kind ?? 'calendar') === 'calendar' &&
      !s.archivedAt &&
      hex
    )
      googleColors.set(s.remoteId as string, hex)
  }
  const events = [...db.events.values()].filter(
    (e) =>
      !e.archivedAt &&
      (e.startAt as string) < q.endAt &&
      ((e.endAt as string | null) ?? (e.startAt as string)) >= q.startAt
  )
  const eventBindings = bindingsFor(
    db,
    'event',
    events.map((e) => e.id as string)
  )
  for (const e of events) {
    const b = eventBindings.get(e.id as string) ?? null
    items.push({
      projectionId: `event:${e.id}`,
      sourceType: 'event',
      sourceId: e.id,
      title: e.title,
      descriptionPreview: preview(e.description),
      startAt: e.startAt as string,
      endAt: e.endAt ?? null,
      isAllDay: e.isAllDay ?? false,
      timezone: e.timezone ?? 'UTC',
      visualType: 'event',
      editability: EDIT_ALL,
      source: native('memrynote'),
      binding: b,
      snoozeOffsetMinutes: null,
      ...eventColors(
        e.colorId,
        googleColors.get(
          (b?.remoteCalendarId as string) ?? (e.targetCalendarId as string | null) ?? ''
        )
      )
    })
  }
  const start = new Date(q.startAt)
  const end = new Date(q.endAt)
  if (end > start) {
    const from = localDate(start)
    const to = localDate(new Date(end.getTime() - 1))
    const tasks = [...db.tasks.values()]
      .filter(
        (t) =>
          t.dueDate &&
          (t.dueDate as string) >= from &&
          (t.dueDate as string) <= to &&
          !t.completedAt &&
          !t.archivedAt
      )
      .sort(
        (a, b) =>
          String(a.dueDate).localeCompare(String(b.dueDate)) ||
          String(a.dueTime ?? '').localeCompare(String(b.dueTime ?? '')) ||
          Number(a.position) - Number(b.position)
      )
    const taskBindings = bindingsFor(
      db,
      'task',
      tasks.map((t) => t.id as string)
    )
    for (const t of tasks) {
      const allDay = !t.dueTime
      items.push({
        projectionId: `task:${t.id}`,
        sourceType: 'task',
        sourceId: t.id,
        title: t.title,
        descriptionPreview: preview(t.description),
        startAt: localInstant(t.dueDate as string, (t.dueTime as string | null) ?? null),
        endAt: allDay ? localAllDayEnd(t.dueDate as string) : null,
        isAllDay: allDay,
        timezone: tz,
        visualType: 'task',
        editability: EDIT_MTD,
        source: native('memrynote Tasks'),
        binding: taskBindings.get(t.id as string) ?? null,
        snoozeOffsetMinutes: null
      })
    }
  }
  const inRange = (v: unknown): boolean => typeof v === 'string' && v >= q.startAt && v < q.endAt
  const position = (r: Row): [string, number | null] => {
    const snoozed = r.status === 'snoozed' && !!r.snoozedUntil
    return snoozed
      ? [
          r.snoozedUntil as string,
          Math.round(
            (new Date(r.snoozedUntil as string).getTime() -
              new Date(r.remindAt as string).getTime()) /
              60000
          )
        ]
      : [r.remindAt as string, null]
  }
  const reminders = [...db.reminders.values()].filter(
    (r) =>
      r.targetType !== 'note_date' &&
      ((r.status === 'pending' && inRange(r.remindAt)) ||
        (r.status === 'snoozed' && inRange(r.snoozedUntil)))
  )
  const reminderBindings = bindingsFor(
    db,
    'reminder',
    reminders.map((r) => r.id as string)
  )
  for (const r of reminders) {
    const [startAt, offset] = position(r)
    items.push({
      projectionId: `reminder:${r.id}`,
      sourceType: 'reminder',
      sourceId: r.id,
      title: (r.title as string | null)?.trim() || 'Reminder',
      descriptionPreview: preview(r.note ?? r.highlightText),
      startAt,
      endAt: null,
      isAllDay: false,
      timezone: tz,
      visualType: 'reminder',
      editability: EDIT_MTD,
      source: native('memrynote Reminders'),
      binding: reminderBindings.get(r.id as string) ?? null,
      snoozeOffsetMinutes: offset
    })
  }
  for (const r of db.reminders.values()) {
    if (r.targetType !== 'note_date') continue
    if (!(
      (r.status !== 'snoozed' && inRange(r.remindAt)) ||
      (r.status === 'snoozed' && inRange(r.snoozedUntil))
    ))
      continue
    const [startAt, offset] = position(r)
    const note = db.notes.get(r.targetId as string)
    items.push({
      projectionId: `note_date:${r.id}`,
      sourceType: 'note_date',
      sourceId: r.id,
      title: (note?.title as string | undefined)?.trim() || 'Untitled',
      descriptionPreview: preview(r.note),
      startAt,
      endAt: null,
      isAllDay: false,
      timezone: tz,
      visualType: 'note_date',
      editability: EDIT_NONE,
      source: native('memrynote Notes'),
      binding: null,
      snoozeOffsetMinutes: offset,
      noteId: r.targetId,
      anchorId: r.anchorId ?? null,
      isTriggered: r.status === 'triggered' || r.status === 'dismissed'
    })
  }
  const snoozes = [...db.inbox.values()].filter(
    (i) => inRange(i.snoozedUntil) && !i.filedAt && !i.archivedAt
  )
  const snoozeBindings = bindingsFor(
    db,
    'inbox_snooze',
    snoozes.map((i) => i.id as string)
  )
  for (const i of snoozes) {
    items.push({
      projectionId: `inbox_snooze:${i.id}`,
      sourceType: 'inbox_snooze',
      sourceId: i.id,
      title: i.title,
      descriptionPreview: preview(i.content),
      startAt: i.snoozedUntil as string,
      endAt: null,
      isAllDay: false,
      timezone: tz,
      visualType: 'snooze',
      editability: { canMove: true, canResize: false, canEditText: false, canDelete: true },
      source: native('memrynote Inbox'),
      binding: snoozeBindings.get(i.id as string) ?? null,
      snoozeOffsetMinutes: null
    })
  }
  for (const e of db.externals.values()) {
    const s = db.sources.get(e.sourceId as string)
    if (!s || e.archivedAt || s.archivedAt) continue
    if (!(
      (e.startAt as string) < q.endAt &&
      ((e.endAt as string | null) ?? (e.startAt as string)) >= q.startAt
    ))
      continue
    if (!q.includeUnselectedSources && s.isSelected !== true) continue
    const provider = (s.provider as string) ?? 'google'
    const writable = provider === 'google' || provider === 'caldav'
    const sourceHex = calendarDisplayHex(s.color as string | null)
    items.push({
      projectionId: `external_event:${e.id}`,
      sourceType: 'external_event',
      sourceId: e.id,
      title: e.title,
      descriptionPreview: preview(e.description),
      startAt: e.startAt as string,
      endAt: e.endAt ?? null,
      isAllDay: e.isAllDay ?? false,
      timezone: (e.timezone as string | null) ?? (s.timezone as string | null) ?? tz,
      visualType: 'external_event',
      editability: writable ? EDIT_ALL : EDIT_NONE,
      source: {
        provider,
        calendarSourceId: s.id,
        title: s.title,
        color: sourceHex,
        kind: s.kind ?? 'calendar',
        isMemryManaged: s.isMemryManaged ?? false
      },
      binding: null,
      snoozeOffsetMinutes: null,
      ...eventColors(e.colorId ?? null, sourceHex)
    })
  }
  const propertyItems: Item[] = []
  for (const n of db.notes.values()) {
    const props = (n.properties as Row | undefined) ?? {}
    for (const name of q.enabledPropertyNames) {
      const value = props[name]
      if (typeof value !== 'string' || !(value >= q.startAt && value < q.endAt)) continue
      const day = dayOf(value)
      if (day === null) continue
      propertyItems.push({
        projectionId: `note:${n.id}:${name}`,
        sourceType: 'note',
        sourceId: n.id,
        title: n.title,
        descriptionPreview: name,
        startAt: localInstant(day, null),
        endAt: localAllDayEnd(day),
        isAllDay: true,
        timezone: tz,
        visualType: 'note',
        editability: EDIT_NONE,
        source: native('memrynote Notes'),
        binding: null,
        snoozeOffsetMinutes: null
      })
    }
  }
  items.push(...propertyItems)
  if (q.showNotesByCreated) {
    const taken = new Set(propertyItems.map((i) => `${i.sourceId}:${i.startAt}`))
    for (const n of db.notes.values()) {
      if ((n.fileType ?? 'markdown') !== 'markdown' || !inRange(n.createdAt)) continue
      const day = dayOf(n.createdAt as string)
      if (day === null) continue
      const startAt = localInstant(day, null)
      if (taken.has(`${n.id}:${startAt}`)) continue
      items.push({
        projectionId: `note-created:${n.id}`,
        sourceType: 'note',
        sourceId: n.id,
        title: n.title,
        descriptionPreview: null,
        startAt,
        endAt: localAllDayEnd(day),
        isAllDay: true,
        timezone: tz,
        visualType: 'note',
        editability: EDIT_NONE,
        source: native('memrynote Notes'),
        binding: null,
        snoozeOffsetMinutes: null
      })
    }
  }
  return items.sort((a, b) =>
    a.startAt !== b.startAt
      ? a.startAt.localeCompare(b.startAt)
      : a.projectionId.localeCompare(b.projectionId)
  )
}

function search(items: Item[], query: string, nowMs: number): Item[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  return items
    .filter(
      (i) =>
        String(i.title ?? '')
          .toLowerCase()
          .includes(q) ||
        String(i.descriptionPreview ?? '')
          .toLowerCase()
          .includes(q)
    )
    .sort(
      (a, b) =>
        Math.abs(new Date(a.startAt).getTime() - nowMs) -
        Math.abs(new Date(b.startAt).getTime() - nowMs)
    )
    .slice(0, 20)
}

/** The zone as the phone passes it: base offset, then each transition. */
function zoneTable(fromMs: number, toMs: number): Row {
  const offset = (ms: number): number => -new Date(ms).getTimezoneOffset() * 60_000
  const transitions: Array<{ atMs: number; offsetMs: number }> = []
  let prev = offset(fromMs)
  for (let t = fromMs; t < toMs; t += 3_600_000) {
    const next = offset(t + 3_600_000)
    if (next !== prev) {
      let lo = t
      let hi = t + 3_600_000
      while (hi - lo > 60_000) {
        const mid = lo + Math.floor((hi - lo) / 2 / 60_000) * 60_000
        if (offset(mid) === prev) lo = mid
        else hi = mid
      }
      transitions.push({ atMs: hi, offsetMs: next })
      prev = next
    }
  }
  return { identifier: PROJECTION_TIMEZONE, baseOffsetMs: offset(fromMs), transitions }
}

function withZone<T>(tz: string, run: () => T): T {
  const previous = process.env.TZ
  process.env.TZ = tz
  try {
    return run()
  } finally {
    if (previous === undefined) delete process.env.TZ
    else process.env.TZ = previous
  }
}

function buildProjection(): Row {
  return withZone(PROJECTION_TIMEZONE, () => {
    const db = loadDb()
    const zone = zoneTable(Date.UTC(2021, 0, 1), Date.UTC(2031, 0, 1))
    const queries = PROJECTION_QUERIES.map((q) => ({ ...q, expected: project(db, q) }))
    const now = new Date(Date.UTC(2026, 10, 2, 12))
    const window = {
      name: 'search window',
      startAt: new Date(now.getFullYear() - 2, 0, 1).toISOString(),
      endAt: new Date(now.getFullYear() + 3, 0, 1).toISOString(),
      includeUnselectedSources: true,
      enabledPropertyNames: [] as string[],
      showNotesByCreated: false
    }
    const all = project(db, window)
    const searches = SEARCH_QUERIES.map((s) => ({
      ...s,
      window,
      expected: search(all, s.query, s.nowMs).map((i) => i.projectionId)
    }))
    return { timezone: PROJECTION_TIMEZONE, zone, rows: PROJECTION_ROWS, queries, searches }
  })
}

// ---------------------------------------------------------------------------
// Writes.
// ---------------------------------------------------------------------------

const DEVICE = 'phone-device'
const NOW = '2026-11-02T12:00:00.000Z'

/** `RecordSyncController` create/update for `calendar_event`. */
function enqueueEvent(local: Row, operation: 'create' | 'update', changed?: string[]): Row {
  const existingClock = (local.clock as VectorClock) ?? {}
  const nextClock = increment(existingClock, DEVICE)
  const fieldClocks: FieldClocks = {
    ...((local.fieldClocks as FieldClocks | null) ??
      initAllFieldClocks(existingClock, EVENT_FIELDS))
  }
  for (const f of operation === 'create' ? EVENT_FIELDS : (changed ?? EVENT_FIELDS))
    fieldClocks[f] = increment(fieldClocks[f] ?? {}, DEVICE)
  return { ...local, clock: nextClock, fieldClocks }
}

function createRow(input: Row): Row {
  const row: Row = {
    id: '$event',
    title: input.title,
    description: input.description ?? null,
    location: input.location ?? null,
    startAt: input.startAt,
    endAt: input.endAt ?? null,
    timezone: input.timezone,
    isAllDay: input.isAllDay,
    recurrenceRule: null,
    recurrenceExceptions: null,
    attendees: null,
    reminders: null,
    visibility: null,
    colorId: colorIdForCalendarEventColor((input.color as CalendarEventColor | null) ?? null),
    conferenceData: null,
    parentEventId: null,
    originalStartTime: null,
    targetCalendarId: input.targetCalendarId ?? null,
    archivedAt: null,
    clock: null,
    fieldClocks: null,
    syncedAt: null,
    createdAt: NOW,
    modifiedAt: NOW
  }
  return enqueueEvent(row, 'create')
}

function updateRow(existing: Row, input: Row): Row {
  const changes: Row = { modifiedAt: NOW }
  for (const k of [
    'title',
    'description',
    'location',
    'startAt',
    'endAt',
    'timezone',
    'isAllDay',
    'targetCalendarId'
  ])
    if (has(input, k))
      changes[k] =
        input[k] ??
        (k === 'title' || k === 'startAt' || k === 'timezone' || k === 'isAllDay' ? input[k] : null)
  if (
    has(input, 'color') &&
    calendarEventColorFromColorId(existing.colorId as string | null) !== (input.color ?? null)
  )
    changes.colorId = colorIdForCalendarEventColor(
      (input.color as CalendarEventColor | null) ?? null
    )
  const changed = Object.keys(changes).filter((f) => f !== 'modifiedAt' && f !== 'targetCalendarId')
  return enqueueEvent({ ...existing, ...changes }, 'update', changed)
}

function buildWrites(): Row {
  const created = createRow({
    title: '[agent] Lunch',
    startAt: '2026-11-03T17:00:00.000Z',
    endAt: '2026-11-03T18:00:00.000Z',
    timezone: 'America/New_York',
    isAllDay: false,
    targetCalendarId: 'work@group.calendar.google.com',
    color: 'sage'
  })
  const updates = [
    {
      name: 'move keeps the colour clock',
      input: {
        startAt: '2026-11-03T18:00:00.000Z',
        endAt: '2026-11-03T19:00:00.000Z',
        color: 'sage'
      }
    },
    {
      name: 'recolour and clear the end',
      input: { color: 'tomato', endAt: null, title: '[agent] Late lunch' }
    },
    {
      name: 'retarget ticks no field clock',
      input: { targetCalendarId: 'other@group.calendar.google.com' }
    },
    { name: 'clearing the colour writes null', input: { color: null, location: 'Cafe' } }
  ].map((u) => ({ ...u, expected: updateRow(created, u.input) }))

  // promote-external-event.ts: event + binding + archived mirror.
  const mirror = { ...external({ desktop: 2 }), id: 'ext-1' }
  const mirrorClock = mirror.clock as VectorClock
  const promotedEvent = enqueueEvent(
    {
      id: '$event',
      title: mirror.title,
      description: mirror.description ?? null,
      location: mirror.location ?? null,
      startAt: mirror.startAt,
      endAt: mirror.endAt ?? null,
      timezone: mirror.timezone ?? 'UTC',
      isAllDay: mirror.isAllDay,
      recurrenceRule: mirror.recurrenceRule ?? null,
      recurrenceExceptions: null,
      attendees: mirror.attendees ?? null,
      reminders: mirror.reminders ?? null,
      visibility: mirror.visibility ?? null,
      colorId: mirror.colorId ?? null,
      conferenceData: mirror.conferenceData ?? null,
      parentEventId: null,
      originalStartTime: null,
      targetCalendarId: 'work@group.calendar.google.com',
      archivedAt: null,
      clock: { ...mirrorClock },
      fieldClocks: null,
      syncedAt: null,
      createdAt: NOW,
      modifiedAt: NOW
    },
    'create'
  )
  const promotedBinding = {
    id: '$binding',
    sourceType: 'event',
    sourceId: '$event',
    provider: 'google',
    remoteCalendarId: 'work@group.calendar.google.com',
    remoteEventId: mirror.remoteEventId,
    ownershipMode: 'provider_managed',
    writebackMode: 'time_and_text',
    remoteVersion: mirror.remoteEtag,
    lastLocalSnapshot: null,
    archivedAt: null,
    clock: increment({ ...mirrorClock }, DEVICE),
    syncedAt: null,
    createdAt: NOW,
    modifiedAt: NOW
  }
  const archivedMirror = {
    ...mirror,
    archivedAt: NOW,
    modifiedAt: NOW,
    clock: increment(mirrorClock, DEVICE)
  }

  return {
    device: DEVICE,
    now: NOW,
    create: {
      input: {
        title: '[agent] Lunch',
        startAt: '2026-11-03T17:00:00.000Z',
        endAt: '2026-11-03T18:00:00.000Z',
        timezone: 'America/New_York',
        isAllDay: false,
        targetCalendarId: 'work@group.calendar.google.com',
        color: 'sage'
      },
      expected: created
    },
    updates,
    promote: {
      source: source({ desktop: 1 }),
      mirror,
      expected: { event: promotedEvent, binding: promotedBinding, mirror: archivedMirror },
      readOnlySource: source({ desktop: 1 }, { provider: 'ics' })
    },
    selection: {
      source: source(
        { desktop: 1 },
        { id: 'src-sel', remoteId: 'selection@group.calendar.google.com' }
      ),
      mirror,
      binding: binding({ desktop: 1 }),
      expected: {
        source: {
          ...source(
            { desktop: 1 },
            { id: 'src-sel', remoteId: 'selection@group.calendar.google.com' }
          ),
          isSelected: false,
          modifiedAt: NOW,
          clock: increment({ desktop: 1 }, DEVICE)
        },
        mirrorDeleted: true,
        bindingDeleted: true
      }
    }
  }
}

// The fixtures' builders, reused for the write section.
function source(clock: Row, extra: Row = {}): Row {
  return PROJECTION_ROWS.find((r) => r.id === 'src-work')?.payload
    ? { ...(PROJECTION_ROWS.find((r) => r.id === 'src-work')?.payload as Row), clock, ...extra }
    : { clock, ...extra }
}
function external(clock: Row): Row {
  return {
    ...(PROJECTION_ROWS.find((r) => r.id === 'ext-work')?.payload as Row),
    startAt: '2026-09-24T07:00:00.000Z',
    endAt: '2026-09-24T08:30:00.000Z',
    colorId: '9',
    clock
  }
}
function binding(clock: Row): Row {
  return {
    ...(PROJECTION_ROWS.find((r) => r.id === 'bind-old')?.payload as Row),
    sourceId: 'evt-1',
    remoteEventId: 'g-1',
    clock
  }
}

export function buildCalendar(): Record<string, unknown> {
  const apply = buildApply()
  const projection = buildProjection()
  const writes = buildWrites()
  return {
    meta: meta({
      class: 'calendar',
      chapter: 'docs/protocol/13-payload-schemas.md',
      sources:
        'packages/sync-client/src/item-handlers/calendar-*-handler.ts, apps/desktop/src/main/sync/item-handlers/calendar-event-handler.ts, apps/desktop/src/main/calendar/projection.ts, apps/desktop/src/main/ipc/calendar-handlers.ts, apps/desktop/src/main/calendar/promote-external-event.ts',
      caseCount:
        apply.length +
        (projection.queries as unknown[]).length +
        (projection.searches as unknown[]).length +
        4
    }),
    apply,
    projection,
    writes
  }
}
