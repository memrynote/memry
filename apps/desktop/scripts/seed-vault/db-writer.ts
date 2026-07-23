import { randomUUID } from 'node:crypto'
import { resolve } from 'path'
import { fileURLToPath } from 'url'
import { dirname } from 'path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import * as schema from '@memry/db-schema/schema'
import {
  canvases,
  canvasEntityRefs,
  projectLinks,
  vaultMetadata
} from '@memry/db-schema/data-schema'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DATA_MIGRATIONS = resolve(__dirname, '../../src/main/database/drizzle-data')

export type DataDb = ReturnType<typeof drizzle<typeof schema>>

export interface OpenedDb {
  db: DataDb
  raw: Database.Database
  close: () => void
}

export function openDataDb(dataDbPath: string): OpenedDb {
  const raw = new Database(dataDbPath)
  raw.pragma('journal_mode = WAL')
  raw.pragma('foreign_keys = ON')
  raw.pragma('synchronous = NORMAL')
  raw.pragma('busy_timeout = 5000')

  const db = drizzle(raw, { schema })
  migrate(db, { migrationsFolder: DATA_MIGRATIONS })

  return {
    db,
    raw,
    close: () => raw.close()
  }
}

export interface SeedTagDefinition {
  name: string
  color: string
}

export function insertTagDefinitions(db: DataDb, tags: SeedTagDefinition[]): number {
  if (tags.length === 0) return 0
  db.insert(schema.tagDefinitions)
    .values(
      tags.map((t) => ({
        name: t.name,
        color: t.color
      }))
    )
    .run()
  return tags.length
}

export interface SeedNoteMetadata {
  id: string
  path: string
  title: string
  emoji?: string | null
  journalDate?: string | null
  createdAt: string
  modifiedAt: string
}

export function insertNoteMetadata(db: DataDb, notes: SeedNoteMetadata[]): number {
  if (notes.length === 0) return 0
  db.insert(schema.noteMetadata)
    .values(
      notes.map((n) => ({
        id: n.id,
        path: n.path,
        title: n.title,
        emoji: n.emoji ?? null,
        journalDate: n.journalDate ?? null,
        createdAt: n.createdAt,
        modifiedAt: n.modifiedAt
      }))
    )
    .run()
  return notes.length
}

export interface SeedFolderConfig {
  path: string
  icon: string | null
}

export function insertFolderConfigs(db: DataDb, folders: SeedFolderConfig[]): number {
  if (folders.length === 0) return 0
  db.insert(schema.folderConfigs)
    .values(
      folders.map((f) => ({
        path: f.path,
        icon: f.icon
      }))
    )
    .run()
  return folders.length
}

export interface SeedPropertyDefinition {
  name: string
  type: string
  options?: string[] | null
  defaultValue?: string | null
  color?: string | null
}

export function insertPropertyDefinitions(db: DataDb, defs: SeedPropertyDefinition[]): number {
  if (defs.length === 0) return 0
  db.insert(schema.propertyDefinitions)
    .values(
      defs.map((d) => ({
        name: d.name,
        type: d.type,
        options: d.options ? JSON.stringify(d.options) : null,
        defaultValue: d.defaultValue ?? null,
        color: d.color ?? null
      }))
    )
    .run()
  return defs.length
}

export interface SeedProject {
  id: string
  name: string
  description?: string | null
  color: string
  icon?: string | null
  position: number
  isInbox?: boolean
  /** Overview note shown at the top of Project Home (projects.home_note_id). */
  homeNoteId?: string | null
}

export function insertProjects(db: DataDb, projects: SeedProject[]): number {
  if (projects.length === 0) return 0
  db.insert(schema.projects)
    .values(
      projects.map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description ?? null,
        color: p.color,
        icon: p.icon ?? null,
        position: p.position,
        isInbox: p.isInbox ?? false,
        homeNoteId: p.homeNoteId ?? null
      }))
    )
    .run()
  return projects.length
}

export interface SeedProjectLink {
  id: string
  projectId: string
  itemType: 'note' | 'calendar_event' | 'file'
  itemId: string
  position: number
}

export function insertProjectLinks(db: DataDb, links: SeedProjectLink[]): number {
  if (links.length === 0) return 0
  db.insert(projectLinks)
    .values(
      links.map((l) => ({
        id: l.id,
        projectId: l.projectId,
        itemType: l.itemType,
        itemId: l.itemId,
        position: l.position
      }))
    )
    .run()
  return links.length
}

export interface SeedStatus {
  id: string
  projectId: string
  name: string
  color: string
  position: number
  isDefault?: boolean
  isDone?: boolean
}

export function insertStatuses(db: DataDb, statuses: SeedStatus[]): number {
  if (statuses.length === 0) return 0
  db.insert(schema.statuses)
    .values(
      statuses.map((s) => ({
        id: s.id,
        projectId: s.projectId,
        name: s.name,
        color: s.color,
        position: s.position,
        isDefault: s.isDefault ?? false,
        isDone: s.isDone ?? false
      }))
    )
    .run()
  return statuses.length
}

export interface SeedTask {
  id: string
  projectId: string
  statusId?: string | null
  parentId?: string | null
  title: string
  description?: string | null
  priority?: number
  position?: number
  dueDate?: string | null
  dueTime?: string | null
  startDate?: string | null
  repeatConfig?: Record<string, unknown> | null
  repeatFrom?: string | null
  sourceNoteId?: string | null
  completedAt?: string | null
  archivedAt?: string | null
  createdAt?: string
  modifiedAt?: string
}

export function insertTasks(db: DataDb, tasks: SeedTask[]): number {
  if (tasks.length === 0) return 0
  for (const t of tasks) {
    db.insert(schema.tasks)
      .values({
        id: t.id,
        projectId: t.projectId,
        statusId: t.statusId ?? null,
        parentId: t.parentId ?? null,
        title: t.title,
        description: t.description ?? null,
        priority: t.priority ?? 0,
        position: t.position ?? 0,
        dueDate: t.dueDate ?? null,
        dueTime: t.dueTime ?? null,
        startDate: t.startDate ?? null,
        repeatConfig: t.repeatConfig ?? null,
        repeatFrom: t.repeatFrom ?? null,
        sourceNoteId: t.sourceNoteId ?? null,
        completedAt: t.completedAt ?? null,
        archivedAt: t.archivedAt ?? null,
        ...(t.createdAt ? { createdAt: t.createdAt } : {}),
        ...(t.modifiedAt ? { modifiedAt: t.modifiedAt } : {})
      })
      .run()
  }
  return tasks.length
}

export interface SeedTaskNote {
  taskId: string
  noteId: string
}

export function insertTaskNotes(db: DataDb, links: SeedTaskNote[]): number {
  if (links.length === 0) return 0
  db.insert(schema.taskNotes)
    .values(
      links.map((l) => ({
        taskId: l.taskId,
        noteId: l.noteId
      }))
    )
    .run()
  return links.length
}

export interface SeedTaskTag {
  taskId: string
  tag: string
}

export function insertTaskTags(db: DataDb, taskTags: SeedTaskTag[]): number {
  if (taskTags.length === 0) return 0
  db.insert(schema.taskTags)
    .values(
      taskTags.map((tt) => ({
        taskId: tt.taskId,
        tag: tt.tag
      }))
    )
    .run()
  return taskTags.length
}

export type SeedCalendarEvent = {
  id: string
  title: string
  description?: string | null
  location?: string | null
  startAt: string
  endAt?: string | null
  timezone?: string
  isAllDay?: boolean
  recurrenceRule?: Record<string, unknown> | null
  recurrenceExceptions?: string[] | null
  attendees?: schema.CalendarAttendee[] | null
  reminders?: schema.CalendarReminders | null
  visibility?: schema.CalendarVisibility | null
  colorId?: string | null
  conferenceData?: schema.CalendarConferenceData | null
  parentEventId?: string | null
  originalStartTime?: string | null
  targetCalendarId?: string | null
  createdAt?: string
  modifiedAt?: string
}

export function insertCalendarEvents(db: DataDb, events: SeedCalendarEvent[]): number {
  if (events.length === 0) return 0
  for (const e of events) {
    db.insert(schema.calendarEvents)
      .values({
        id: e.id,
        title: e.title,
        description: e.description ?? null,
        location: e.location ?? null,
        startAt: e.startAt,
        endAt: e.endAt ?? null,
        timezone: e.timezone ?? 'UTC',
        isAllDay: e.isAllDay ?? false,
        recurrenceRule: e.recurrenceRule ?? null,
        recurrenceExceptions: e.recurrenceExceptions ?? null,
        attendees: e.attendees ?? null,
        reminders: e.reminders ?? null,
        visibility: e.visibility ?? null,
        colorId: e.colorId ?? null,
        conferenceData: e.conferenceData ?? null,
        parentEventId: e.parentEventId ?? null,
        originalStartTime: e.originalStartTime ?? null,
        targetCalendarId: e.targetCalendarId ?? null,
        ...(e.createdAt ? { createdAt: e.createdAt } : {}),
        ...(e.modifiedAt ? { modifiedAt: e.modifiedAt } : {})
      })
      .run()
  }
  return events.length
}

export interface SeedCalendarSource {
  id: string
  provider: string
  kind: schema.CalendarSourceKind
  accountId?: string | null
  remoteId: string
  title: string
  timezone?: string | null
  color?: string | null
  isPrimary?: boolean
  isSelected?: boolean
  isMemryManaged?: boolean
  syncStatus?: schema.CalendarSourceSyncStatus
  lastSyncedAt?: string | null
}

export function insertCalendarSources(db: DataDb, sources: SeedCalendarSource[]): number {
  if (sources.length === 0) return 0
  db.insert(schema.calendarSources)
    .values(
      sources.map((s) => ({
        id: s.id,
        provider: s.provider,
        kind: s.kind,
        accountId: s.accountId ?? null,
        remoteId: s.remoteId,
        title: s.title,
        timezone: s.timezone ?? null,
        color: s.color ?? null,
        isPrimary: s.isPrimary ?? false,
        isSelected: s.isSelected ?? false,
        isMemryManaged: s.isMemryManaged ?? false,
        syncStatus: s.syncStatus ?? 'idle',
        lastSyncedAt: s.lastSyncedAt ?? null
      }))
    )
    .run()
  return sources.length
}

export interface SeedInboxItem {
  id: string
  type: string
  title: string
  content?: string | null
  filedAt?: string | null
  filedTo?: string | null
  filedAction?: string | null
  snoozedUntil?: string | null
  snoozeReason?: string | null
  viewedAt?: string | null
  processingStatus?: string
  metadata?: Record<string, unknown> | null
  attachmentPath?: string | null
  thumbnailPath?: string | null
  transcription?: string | null
  transcriptionStatus?: string | null
  sourceUrl?: string | null
  sourceTitle?: string | null
  captureSource?: string | null
  archivedAt?: string | null
  createdAt?: string
  modifiedAt?: string
  tags?: string[]
}

export function insertInboxItems(db: DataDb, items: SeedInboxItem[]): number {
  if (items.length === 0) return 0
  for (const item of items) {
    db.insert(schema.inboxItems)
      .values({
        id: item.id,
        type: item.type,
        title: item.title,
        content: item.content ?? null,
        filedAt: item.filedAt ?? null,
        filedTo: item.filedTo ?? null,
        filedAction: item.filedAction ?? null,
        snoozedUntil: item.snoozedUntil ?? null,
        snoozeReason: item.snoozeReason ?? null,
        viewedAt: item.viewedAt ?? null,
        processingStatus: item.processingStatus ?? 'complete',
        metadata: item.metadata ?? null,
        attachmentPath: item.attachmentPath ?? null,
        thumbnailPath: item.thumbnailPath ?? null,
        transcription: item.transcription ?? null,
        transcriptionStatus: item.transcriptionStatus ?? null,
        sourceUrl: item.sourceUrl ?? null,
        sourceTitle: item.sourceTitle ?? null,
        captureSource: item.captureSource ?? null,
        archivedAt: item.archivedAt ?? null,
        ...(item.createdAt ? { createdAt: item.createdAt } : {}),
        ...(item.modifiedAt ? { modifiedAt: item.modifiedAt } : {})
      })
      .run()

    if (item.tags && item.tags.length > 0) {
      db.insert(schema.inboxItemTags)
        .values(
          item.tags.map((tag, i) => ({
            id: `${item.id}_tag_${i}`,
            itemId: item.id,
            tag
          }))
        )
        .run()
    }
  }
  return items.length
}

export interface SeedFilingHistory {
  id: string
  itemType: string
  itemContent?: string | null
  filedTo: string
  filedAction: string
  tags?: string[] | null
  filedAt?: string
}

export function insertFilingHistory(db: DataDb, history: SeedFilingHistory[]): number {
  if (history.length === 0) return 0
  for (const h of history) {
    db.insert(schema.filingHistory)
      .values({
        id: h.id,
        itemType: h.itemType,
        itemContent: h.itemContent ?? null,
        filedTo: h.filedTo,
        filedAction: h.filedAction,
        tags: h.tags ?? null,
        ...(h.filedAt ? { filedAt: h.filedAt } : {})
      })
      .run()
  }
  return history.length
}

export interface SeedHomeWidget {
  id: string
  type: string
  // react-grid-layout coords on the 8-column Home grid.
  x: number
  y: number
  w: number
  h: number
  config?: Record<string, unknown>
}

export interface SeedHomePage {
  id: string
  name: string
  icon?: string | null
  position: number
  widgets: SeedHomeWidget[]
}

export function insertHomePages(db: DataDb, pages: SeedHomePage[]): number {
  if (pages.length === 0) return 0
  db.insert(schema.homePages)
    .values(
      pages.map((p) => ({
        id: p.id,
        name: p.name,
        icon: p.icon ?? null,
        position: p.position,
        // widgets column is JSON-encoded WidgetInstance[]; parsed by the IPC layer.
        widgets: JSON.stringify(
          p.widgets.map((w) => ({
            id: w.id,
            type: w.type,
            x: w.x,
            y: w.y,
            w: w.w,
            h: w.h,
            config: w.config ?? {}
          }))
        )
      }))
    )
    .run()
  return pages.length
}

/**
 * Creates the vault_metadata singleton the app otherwise writes on first open
 * (see main/agent/storage/vault-id.ts). Canvas rows carry this vault UUID.
 */
export function ensureVaultMetadata(db: DataDb): string {
  const existing = db.select().from(vaultMetadata).get()
  if (existing) return existing.vaultUuid

  const uuid = randomUUID()
  const now = Date.now()
  db.insert(vaultMetadata)
    .values({ id: 'singleton', vaultUuid: uuid, createdAt: now, updatedAt: now })
    .run()
  return uuid
}

export function upsertSetting(db: DataDb, key: string, value: string): void {
  db.insert(schema.settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value } })
    .run()
}

export interface SeedCanvasRow {
  id: string
  title: string
  snapshotCiphertext: string
  entityRefs: Array<{ entityType: 'note' | 'task' | 'calendar_event'; entityId: string }>
}

export function insertCanvases(db: DataDb, vaultId: string, rows: SeedCanvasRow[]): number {
  if (rows.length === 0) return 0
  const now = Date.now()
  for (const c of rows) {
    db.insert(canvases)
      .values({
        id: c.id,
        vaultId,
        title: c.title,
        snapshotCiphertext: c.snapshotCiphertext,
        vectorClock: {},
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        lastSyncedAt: null,
        clock: null
      })
      .run()
    for (const ref of c.entityRefs) {
      db.insert(canvasEntityRefs)
        .values({ canvasId: c.id, entityType: ref.entityType, entityId: ref.entityId })
        .onConflictDoNothing()
        .run()
    }
  }
  return rows.length
}

export interface SeedBookmark {
  id: string
  itemType: string
  itemId: string
  position: number
  createdAt?: string
}

export function insertBookmarks(db: DataDb, rows: SeedBookmark[]): number {
  if (rows.length === 0) return 0
  db.insert(schema.bookmarks)
    .values(
      rows.map((b) => ({
        id: b.id,
        itemType: b.itemType,
        itemId: b.itemId,
        position: b.position,
        ...(b.createdAt ? { createdAt: b.createdAt } : {})
      }))
    )
    .run()
  return rows.length
}
