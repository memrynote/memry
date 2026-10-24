import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { and, asc, desc, eq, inArray, isNull, lt, type SQL } from 'drizzle-orm'
import type { CalendarService } from '@memry/app-core/calendar-types'
import { createId } from '@memry/app-core/ids'
import type { RemindersService } from '@memry/app-core/reminders'
import type { InboxBulkResponse, InboxRecord, InboxService } from '@memry/app-core/service-types'
import {
  filingHistory,
  inboxItems,
  inboxItemTags,
  inboxJobs,
  settings as settingsTable
} from '@memry/db-schema/data-schema'
import type { DataDb } from './database.ts'
import type { FoldersService } from './folders.ts'
import type { NotesService } from './notes.ts'
import { normalizePath } from './paths.ts'
import { errorCode } from './errno.ts'

export type InboxFilingAction = 'folder' | 'note' | 'linked' | 'task' | 'event' | 'reminder'
export type InboxJobType = 'transcription' | 'metadata-scrape'

export interface InboxFileOutcome {
  success: boolean
  filedTo: string | null
  noteId?: string
  error?: string
}

export interface InboxJobRecord {
  id: string
  itemId: string
  type: string
  status: string
  runAt: string
  attempts: number
  maxAttempts: number
  payload: Record<string, unknown> | null
  result: Record<string, unknown> | null
  lastError: string | null
  startedAt: string | null
  completedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface InboxFilingSuggestion {
  destination: { type: 'folder'; path: string }
  confidence: number
  reason: string
  suggestedTags: string[]
}

export type InboxBinaryKind = 'image' | 'pdf' | 'voice'

export interface InboxFilingService {
  file(id: string, folder: string, tags?: string[]): Promise<InboxFileOutcome>
  bulkFile(ids: string[], folder: string, tags?: string[]): Promise<InboxBulkResponse>
  fileAllStale(): Promise<InboxBulkResponse>
  convertToEvent(
    id: string,
    input: { startAt: string; endAt?: string | null; isAllDay?: boolean; location?: string | null }
  ): Promise<{ success: boolean; eventId: string | null; error?: string }>
  convertToReminder(
    id: string,
    input: { remindAt: string }
  ): Promise<{ success: boolean; noteId: string | null; error?: string }>
  suggestions(id: string): Promise<{ suggestions: InboxFilingSuggestion[] }>
  undoArchive(id: string): Promise<{ success: boolean; error?: string }>
  undoFile(id: string): Promise<{ success: boolean; error?: string }>
  captureBinary(
    kind: InboxBinaryKind,
    input: { filePath: string; title?: string; tags?: string[]; transcribe?: boolean }
  ): Promise<InboxRecord>
  jobs(options?: { itemIds?: string[]; statuses?: string[] }): Promise<{ jobs: InboxJobRecord[] }>
  retry(id: string): Promise<{ success: boolean; error?: string }>
}

type ItemRow = typeof inboxItems.$inferSelect

const staleThresholdKey = 'inbox.staleThresholdDays'
const staleFolder = 'Unsorted'

// Same sets as desktop's filing.ts `isBinaryType` / `isNoteOnlyType`.
function isBinaryType(type: string): boolean {
  return ['image', 'voice', 'pdf', 'video'].includes(type)
}

function isNoteOnlyType(type: string): boolean {
  return ['image', 'pdf', 'video', 'clip'].includes(type)
}

function nowIso(): string {
  return new Date().toISOString()
}

function formatDateTime(date: Date): string {
  return date.toISOString().slice(0, 16).replace('T', ' ')
}

function uniqueTags(tags: string[]): string[] {
  return [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))]
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error'
}

/** Desktop's `generateNoteTitle`, minus the clip/link branches that need page metadata. */
function noteTitle(item: ItemRow): string {
  const title = item.title?.trim()
  if (title && !(item.type === 'link' && item.title === item.sourceUrl)) return title
  if (item.type === 'link' && item.sourceUrl) {
    try {
      return `Link from ${new URL(item.sourceUrl).hostname}`
    } catch {
      return `Inbox Note - ${formatDateTime(new Date())}`
    }
  }
  const firstLine = item.content?.split('\n')[0]?.trim()
  if (firstLine && firstLine.length <= 100) return firstLine.replace(/^#+\s*/, '')
  return `Inbox Note - ${formatDateTime(new Date())}`
}

function noteBody(item: ItemRow): string {
  const filedDate = new Date().toISOString().slice(0, 10)
  const parts: string[] = []
  if (item.type === 'link' && item.sourceUrl) {
    parts.push(`[${item.title}](${item.sourceUrl} "mention")`)
    if (item.content) parts.push(`> ${item.content}`)
  } else {
    parts.push(item.content ?? '')
    if (item.type === 'clip' && item.sourceUrl) {
      parts.push(`**Source:** [${item.sourceTitle || item.sourceUrl}](${item.sourceUrl})`)
    }
  }
  parts.push(`---\n*Filed from Inbox on ${filedDate}*`)
  return parts.filter((part) => part.length > 0).join('\n\n')
}

function filedBinaryName(item: ItemRow): string {
  const stored = path.basename(item.attachmentPath ?? '')
  const base = noteTitle(item)
    .replace(/[<>:"/\\|?*]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/g, '')
    .trim()
    .replace(/[.\s]+$/g, '')
    .slice(0, 200)
  return base.length === 0 ? stored : `${base}${path.extname(stored)}`
}

function uniquePath(filePath: string): string {
  if (!existsSync(filePath)) return filePath
  const dir = path.dirname(filePath)
  const ext = path.extname(filePath)
  const base = path.basename(filePath, ext)
  let counter = 1
  let candidate = filePath
  while (existsSync(candidate)) {
    candidate = path.join(dir, `${base}-${counter}${ext}`)
    counter += 1
  }
  return candidate
}

function safeFolder(folder: string): string {
  const normalized = normalizePath(folder)
  if (normalized.split('/').some((segment) => segment === '..')) {
    throw new Error(`Folder must stay inside the vault: ${folder}`)
  }
  if (path.isAbsolute(folder)) throw new Error(`Folder must be vault-relative: ${folder}`)
  return normalized
}

const captureMimeByKind: Record<InboxBinaryKind, Record<string, string>> = {
  image: {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml'
  },
  pdf: { '.pdf': 'application/pdf' },
  voice: {
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.webm': 'audio/webm',
    '.m4a': 'audio/mp4',
    '.ogg': 'audio/ogg',
    '.flac': 'audio/flac',
    '.aac': 'audio/aac'
  }
}

function toJobRecord(row: typeof inboxJobs.$inferSelect): InboxJobRecord {
  return {
    id: row.id,
    itemId: row.itemId,
    type: row.type,
    status: row.status,
    runAt: row.runAt,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    payload: row.payload ?? null,
    result: row.result ?? null,
    lastError: row.lastError,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }
}

export function createInboxFilingService({
  dataDb,
  vaultPath,
  notes,
  folders,
  calendar,
  reminders,
  inbox
}: {
  dataDb: DataDb
  vaultPath: string
  notes: NotesService
  folders: FoldersService
  calendar: CalendarService
  reminders: RemindersService
  inbox: InboxService
}): InboxFilingService {
  function getItem(id: string): ItemRow | undefined {
    return dataDb.select().from(inboxItems).where(eq(inboxItems.id, id)).get()
  }

  function itemTags(id: string): string[] {
    return dataDb
      .select()
      .from(inboxItemTags)
      .where(eq(inboxItemTags.itemId, id))
      .all()
      .map((row) => row.tag)
  }

  function markFiled(id: string, filedTo: string, filedAction: InboxFilingAction): void {
    const now = nowIso()
    dataDb
      .update(inboxItems)
      .set({
        filedAt: now,
        filedTo,
        filedAction,
        modifiedAt: now,
        snoozedUntil: null,
        snoozeReason: null
      })
      .where(eq(inboxItems.id, id))
      .run()
  }

  function recordHistory(
    item: ItemRow,
    filedTo: string,
    filedAction: InboxFilingAction,
    tags: string[]
  ): void {
    dataDb
      .insert(filingHistory)
      .values({
        id: createId('filing'),
        itemType: item.type,
        itemContent: isBinaryType(item.type) ? null : (item.content?.slice(0, 500) ?? null),
        filedTo,
        filedAction,
        tags,
        filedAt: nowIso()
      })
      .run()
  }

  function upsertJob(
    itemId: string,
    type: InboxJobType,
    payload: Record<string, unknown>,
    maxAttempts: number
  ): void {
    const now = nowIso()
    const existing = dataDb
      .select()
      .from(inboxJobs)
      .where(and(eq(inboxJobs.itemId, itemId), eq(inboxJobs.type, type)))
      .get()
    if (existing) {
      dataDb
        .update(inboxJobs)
        .set({
          status: 'pending',
          runAt: now,
          attempts: 0,
          maxAttempts,
          payload,
          result: null,
          lastError: null,
          startedAt: null,
          completedAt: null,
          updatedAt: now
        })
        .where(eq(inboxJobs.id, existing.id))
        .run()
      return
    }
    dataDb
      .insert(inboxJobs)
      .values({
        id: createId('inbox_job'),
        itemId,
        type,
        status: 'pending',
        runAt: now,
        attempts: 0,
        maxAttempts,
        payload,
        createdAt: now,
        updatedAt: now
      })
      .run()
  }

  async function fileBinary(item: ItemRow, folder: string, tags: string[]): Promise<string> {
    if (!item.attachmentPath) throw new Error('No attachment found for this item')
    const source = path.join(vaultPath, item.attachmentPath)
    const destFolder = path.join(vaultPath, folder)
    await fs.mkdir(destFolder, { recursive: true })
    const destination = uniquePath(path.join(destFolder, filedBinaryName(item)))
    try {
      await fs.rename(source, destination)
    } catch (error) {
      if (errorCode(error) !== 'EXDEV') throw error
      await fs.copyFile(source, destination)
      await fs.unlink(source)
    }
    await fs.rm(path.dirname(source), { recursive: true, force: true })
    const relative = normalizePath(path.relative(vaultPath, destination))
    markFiled(item.id, relative, 'folder')
    recordHistory(item, relative, 'folder', tags)
    return relative
  }

  async function fileOne(id: string, rawFolder: string, extraTags: string[]) {
    try {
      const folder = safeFolder(rawFolder)
      const item = getItem(id)
      if (!item) return { success: false, filedTo: null, error: 'Inbox item not found' }
      if (item.filedAt) {
        return { success: false, filedTo: null, error: 'Item has already been filed' }
      }
      const tags = [...new Set([...itemTags(id), ...uniqueTags(extraTags), 'inbox'])]

      if (isBinaryType(item.type)) {
        return { success: true, filedTo: await fileBinary(item, folder, tags) }
      }

      if (folder) await folders.create(folder)
      const note = await notes.create({
        title: noteTitle(item),
        content: noteBody(item),
        folder: folder || undefined,
        tags
      })
      markFiled(id, note.path, 'folder')
      recordHistory(item, note.path, 'folder', tags)
      return { success: true, filedTo: note.path, noteId: note.id }
    } catch (error) {
      return { success: false, filedTo: null, error: errorMessage(error) }
    }
  }

  async function bulkFile(
    ids: string[],
    folder: string,
    tags: string[] = []
  ): Promise<InboxBulkResponse> {
    const errors: InboxBulkResponse['errors'] = []
    let processedCount = 0
    for (const itemId of ids) {
      const result = await fileOne(itemId, folder, tags)
      if (result.success) processedCount += 1
      else errors.push({ itemId, error: result.error ?? 'Unknown error' })
    }
    return { success: errors.length === 0, processedCount, errors }
  }

  function staleThresholdDays(): number {
    const row = dataDb
      .select({ value: settingsTable.value })
      .from(settingsTable)
      .where(eq(settingsTable.key, staleThresholdKey))
      .get()
    const parsed = row ? Number.parseInt(row.value, 10) : Number.NaN
    return Number.isFinite(parsed) ? Math.max(1, Math.min(365, parsed)) : 7
  }

  return {
    file: (id, folder, tags = []) => fileOne(id, folder, tags),
    bulkFile,

    async fileAllStale() {
      const cutoff = new Date()
      cutoff.setDate(cutoff.getDate() - staleThresholdDays())
      const ids = dataDb
        .select({ id: inboxItems.id })
        .from(inboxItems)
        .where(
          and(
            isNull(inboxItems.filedAt),
            isNull(inboxItems.snoozedUntil),
            isNull(inboxItems.archivedAt),
            lt(inboxItems.createdAt, cutoff.toISOString())
          )
        )
        .all()
        .map((row) => row.id)
      if (ids.length === 0) return { success: true, processedCount: 0, errors: [] }
      return bulkFile(ids, staleFolder)
    },

    async convertToEvent(id, input) {
      try {
        const item = getItem(id)
        if (!item) return { success: false, eventId: null, error: 'Inbox item not found' }
        if (item.filedAt) {
          return { success: false, eventId: null, error: 'Item has already been filed' }
        }
        if (isNoteOnlyType(item.type)) {
          return {
            success: false,
            eventId: null,
            error: 'Only text and voice items can become an event'
          }
        }
        const event = await calendar.events.create({
          title: noteTitle(item),
          description: (item.type === 'voice' ? item.transcription : item.content) ?? null,
          location: input.location ?? null,
          startAt: input.startAt,
          endAt: input.endAt ?? null,
          timezone: 'UTC',
          isAllDay: input.isAllDay ?? false
        })
        markFiled(id, event.id, 'event')
        recordHistory(item, event.id, 'event', [...new Set([...itemTags(id), 'inbox'])])
        return { success: true, eventId: event.id }
      } catch (error) {
        return { success: false, eventId: null, error: errorMessage(error) }
      }
    },

    async convertToReminder(id, input) {
      try {
        const item = getItem(id)
        if (!item) return { success: false, noteId: null, error: 'Inbox item not found' }
        if (item.filedAt) {
          return { success: false, noteId: null, error: 'Item has already been filed' }
        }
        if (isNoteOnlyType(item.type)) {
          return {
            success: false,
            noteId: null,
            error: 'Only text and voice items can become a reminder'
          }
        }
        const remindMs = new Date(input.remindAt).getTime()
        if (Number.isNaN(remindMs)) {
          return { success: false, noteId: null, error: 'Invalid reminder time' }
        }
        if (remindMs <= Date.now()) {
          return { success: false, noteId: null, error: 'Reminder time must be in the future' }
        }
        const tags = [...new Set([...itemTags(id), 'inbox'])]
        const title = noteTitle(item)
        const note = await notes.create({ title, content: noteBody(item), tags })
        await reminders.create({
          targetType: 'note',
          targetId: note.id,
          remindAt: input.remindAt,
          title
        })
        markFiled(id, note.path, 'reminder')
        recordHistory(item, note.path, 'reminder', tags)
        return { success: true, noteId: note.id }
      } catch (error) {
        return { success: false, noteId: null, error: errorMessage(error) }
      }
    },

    // The embedding-ranked half of desktop's suggestions needs its local model,
    // so this is the filing-history half only: where similar items went before.
    async suggestions(id) {
      const item = getItem(id)
      if (!item) throw new Error(`Inbox item not found: ${id}`)
      const history = dataDb
        .select()
        .from(filingHistory)
        .where(and(eq(filingHistory.itemType, item.type), eq(filingHistory.filedAction, 'folder')))
        .orderBy(desc(filingHistory.filedAt))
        .limit(200)
        .all()
      const byFolder = new Map<string, { count: number; tags: Map<string, number> }>()
      for (const row of history) {
        const folder = normalizePath(path.posix.dirname(row.filedTo.replaceAll('\\', '/')))
        const key = folder === '.' ? '' : folder
        const entry = byFolder.get(key) ?? { count: 0, tags: new Map<string, number>() }
        entry.count += 1
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- untyped JSON or driver result; shape fixed by the producer, a runtime parser would change accepted input
        const rowTags = Array.isArray(row.tags) ? (row.tags as string[]) : []
        for (const tag of rowTags) {
          if (tag !== 'inbox') entry.tags.set(tag, (entry.tags.get(tag) ?? 0) + 1)
        }
        byFolder.set(key, entry)
      }
      const total = history.length
      const suggestions = [...byFolder.entries()]
        .toSorted((left, right) => right[1].count - left[1].count)
        .slice(0, 3)
        .map(([folder, entry]): InboxFilingSuggestion => ({
          destination: { type: 'folder', path: folder },
          confidence: Math.round((entry.count / total) * 100) / 100,
          reason: `${entry.count} of ${total} similar ${item.type} items were filed here`,
          suggestedTags: [...entry.tags.entries()]
            .toSorted((left, right) => right[1] - left[1])
            .slice(0, 3)
            .map(([tag]) => tag)
        }))
      return { suggestions }
    },

    async undoArchive(id) {
      const item = getItem(id)
      if (!item) return { success: false, error: 'Item not found' }
      if (!item.archivedAt) return { success: false, error: 'Item is not archived' }
      dataDb
        .update(inboxItems)
        .set({ archivedAt: null, modifiedAt: nowIso() })
        .where(eq(inboxItems.id, id))
        .run()
      return { success: true }
    },

    async undoFile(id) {
      const item = getItem(id)
      if (!item) return { success: false, error: 'Item not found' }
      if (!item.filedAt) return { success: false, error: 'Item is not filed' }
      dataDb
        .update(inboxItems)
        .set({ filedAt: null, filedTo: null, filedAction: null, modifiedAt: nowIso() })
        .where(eq(inboxItems.id, id))
        .run()
      return { success: true }
    },

    async captureBinary(kind, input) {
      const extension = path.extname(input.filePath).toLowerCase()
      const mimeType = captureMimeByKind[kind][extension]
      if (!mimeType) {
        throw new Error(
          `Unsupported ${kind} file: ${input.filePath} (expected ${Object.keys(captureMimeByKind[kind]).join(', ')})`
        )
      }
      const item = await inbox.captureFile({
        filePath: input.filePath,
        mimeType,
        title: input.title,
        tags: input.tags
      })
      if (kind === 'voice' && input.transcribe !== false && item.attachmentPath) {
        upsertJob(item.id, 'transcription', { attachmentPath: item.attachmentPath }, 1)
      }
      return item
    },

    async jobs(options = {}) {
      const conditions: SQL[] = []
      if (options.itemIds?.length) conditions.push(inArray(inboxJobs.itemId, options.itemIds))
      if (options.statuses?.length) conditions.push(inArray(inboxJobs.status, options.statuses))
      const rows = dataDb
        .select()
        .from(inboxJobs)
        .where(conditions.length ? and(...conditions) : undefined)
        .orderBy(asc(inboxJobs.runAt))
        .all()
      return { jobs: rows.map(toJobRecord) }
    },

    // Re-queues the durable job and flips the item back to pending. The
    // scrape and the transcription run in the desktop app, which resumes
    // pending jobs when it opens the vault.
    async retry(id) {
      const item = getItem(id)
      if (!item) return { success: false, error: 'Item not found' }
      const now = nowIso()
      if (item.type === 'link') {
        if (!item.sourceUrl) return { success: false, error: 'Item has no source URL' }
        dataDb
          .update(inboxItems)
          .set({ processingStatus: 'pending', processingError: null, modifiedAt: now })
          .where(eq(inboxItems.id, id))
          .run()
        upsertJob(id, 'metadata-scrape', { url: item.sourceUrl }, 2)
        return { success: true }
      }
      if (item.type === 'voice') {
        if (!item.attachmentPath)
          return { success: false, error: 'No audio file attached to this item' }
        dataDb
          .update(inboxItems)
          .set({ transcriptionStatus: 'pending', processingError: null, modifiedAt: now })
          .where(eq(inboxItems.id, id))
          .run()
        upsertJob(id, 'transcription', { attachmentPath: item.attachmentPath }, 1)
        return { success: true }
      }
      return { success: false, error: 'Only link and voice items can be retried' }
    }
  }
}
