import type { InboxRecord, InboxBulkResponse, InboxService } from '@memry/app-core/service-types'
export type { InboxRecord, CaptureTextInput, CaptureLinkInput, CaptureFileInput, UpdateInboxInput, InboxFileResponse, InboxBulkResponse, InboxFilingHistoryEntry, InboxCapturePattern, InboxService } from '@memry/app-core/service-types'
import fs from 'node:fs/promises'
import path from 'node:path'
import { and, asc, eq } from 'drizzle-orm'
import { inboxItems, inboxItemTags, settings as settingsTable } from '@memry/db-schema/data-schema'
import type { DataDb } from './database.ts'
import { createId } from '@memry/app-core/ids'
import type { NotesService } from './notes.ts'
import type { TasksService } from '@memry/app-core/tasks'

function nowIso(): string {
  return new Date().toISOString()
}

function tagsForItem(db: DataDb, itemId: string): string[] {
  return db
    .select()
    .from(inboxItemTags)
    .where(eq(inboxItemTags.itemId, itemId))
    .all()
    .map((row) => row.tag)
}

function setTags(db: DataDb, itemId: string, tags: string[]): void {
  for (const tag of tags) {
    const normalized = tag.trim()
    if (!normalized) continue
    db.insert(inboxItemTags)
      .values({ id: createId('inbox_tag'), itemId, tag: normalized, createdAt: nowIso() })
      .run()
  }
}

function toInboxRecord(db: DataDb, row: typeof inboxItems.$inferSelect): InboxRecord {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    content: row.content,
    createdAt: row.createdAt,
    modifiedAt: row.modifiedAt,
    filedAt: row.filedAt,
    filedTo: row.filedTo,
    filedAction: row.filedAction,
    archivedAt: row.archivedAt,
    viewedAt: row.viewedAt,
    snoozedUntil: row.snoozedUntil,
    snoozeReason: row.snoozeReason,
    processingStatus: row.processingStatus,
    sourceUrl: row.sourceUrl,
    sourceTitle: row.sourceTitle,
    metadata: row.metadata,
    attachmentPath: row.attachmentPath,
    thumbnailPath: row.thumbnailPath,
    tags: tagsForItem(db, row.id)
  }
}

const mimeTypesByExtension: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
  '.aac': 'audio/aac',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.mkv': 'video/x-matroska',
  '.pdf': 'application/pdf'
}

function inboxTypeFromMime(mimeType: string): 'image' | 'voice' | 'video' | 'pdf' {
  if (mimeType.startsWith('image/')) return 'image'
  if (mimeType.startsWith('audio/')) return 'voice'
  if (mimeType.startsWith('video/')) return 'video'
  if (mimeType === 'application/pdf') return 'pdf'
  throw new Error(`Unsupported inbox file type: ${mimeType}`)
}

function sanitizeFilename(filename: string): string {
  return filename
    .replace(/[^a-zA-Z0-9.-]/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 100)
}

function titleFromUrl(url: string): string {
  try {
    const parsed = new URL(url)
    const segments = parsed.pathname.split('/').filter(Boolean)
    if (segments.length === 0) return parsed.hostname.replace(/^www\./, '')

    const cleaned = segments[segments.length - 1]
      ?.replace(/\.[a-z]+$/, '')
      .replace(/--\d+$/, '')
      .replace(/-\d+$/, '')
      .replace(/[-_]+/g, ' ')
      .trim()

    if (!cleaned) return parsed.hostname.replace(/^www\./, '')
    return cleaned.replace(/\b\w/g, (character) => character.toUpperCase())
  } catch {
    return url
  }
}

function uniqueTags(tags: string[]): string[] {
  // Case-insensitive dedupe, first spelling wins
  const byKey = new Map<string, string>()
  for (const raw of tags) {
    const tag = raw.trim()
    if (!tag) continue
    const key = tag.toLowerCase()
    if (!byKey.has(key)) byKey.set(key, tag)
  }
  return [...byKey.values()]
}

function generateInboxNoteContent(item: InboxRecord): string {
  const sections: string[] = []
  if (item.sourceUrl) {
    sections.push(`[${item.title}](${item.sourceUrl})`)
  }
  if (item.content) {
    sections.push(item.content)
  }
  if (sections.length === 0) {
    sections.push(item.title)
  }
  sections.push(`---\nFiled from Inbox on ${new Date().toISOString().slice(0, 10)}`)
  return sections.join('\n\n')
}

function captureEntry(item: InboxRecord, title: string): string {
  const description = item.sourceUrl
    ? ` - ${item.sourceUrl}`
    : item.content
      ? ` - ${item.content}`
      : ''
  return `- [[${title}]]${description.slice(0, 80)}`
}

function markFiled(
  dataDb: DataDb,
  id: string,
  filedTo: string,
  filedAction: 'folder' | 'note' | 'linked'
): void {
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

const staleThresholdKey = 'inbox.staleThresholdDays'

function clampStaleThreshold(days: number): number {
  if (!Number.isFinite(days)) return 7
  return Math.max(1, Math.min(365, Math.trunc(days)))
}

function readStaleThreshold(dataDb: DataDb): number {
  const row = dataDb
    .select({ value: settingsTable.value })
    .from(settingsTable)
    .where(eq(settingsTable.key, staleThresholdKey))
    .get()
  if (!row) return 7
  const parsed = Number.parseInt(row.value, 10)
  return Number.isFinite(parsed) ? clampStaleThreshold(parsed) : 7
}

function writeSetting(dataDb: DataDb, key: string, value: string): void {
  const modifiedAt = nowIso()
  dataDb
    .insert(settingsTable)
    .values({ key, value, modifiedAt })
    .onConflictDoUpdate({
      target: settingsTable.key,
      set: { value, modifiedAt }
    })
    .run()
}

export function createInboxService({
  dataDb,
  vaultPath,
  notes,
  tasks
}: {
  dataDb: DataDb
  vaultPath: string
  notes: NotesService
  tasks: TasksService
}): InboxService {
  return {
    async captureText(input) {
      const time = nowIso()
      const id = createId('inbox')
      dataDb
        .insert(inboxItems)
        .values({
          id,
          type: 'note',
          title: input.title ?? input.content.slice(0, 80),
          content: input.content,
          createdAt: time,
          modifiedAt: time,
          processingStatus: 'complete',
          captureSource: 'api'
        })
        .run()
      if (input.tags) setTags(dataDb, id, input.tags)
      const item = await this.get(id)
      if (!item) throw new Error('Inbox item not found after create')
      return item
    },

    async captureLink(input) {
      const url = input.url.trim()
      if (!url) throw new Error('Inbox link URL is required')
      const time = nowIso()
      const id = createId('inbox')
      dataDb
        .insert(inboxItems)
        .values({
          id,
          type: 'link',
          title: titleFromUrl(url),
          content: null,
          sourceUrl: url,
          createdAt: time,
          modifiedAt: time,
          processingStatus: 'pending',
          captureSource: 'api',
          metadata: { url, fetchStatus: 'pending' }
        })
        .run()
      if (input.tags) setTags(dataDb, id, input.tags)
      const item = await this.get(id)
      if (!item) throw new Error('Inbox item not found after link capture')
      return item
    },

    async captureFile(input) {
      const sourcePath = path.resolve(input.filePath)
      const stat = await fs.stat(sourcePath)
      if (!stat.isFile()) throw new Error(`Inbox file is not a regular file: ${input.filePath}`)
      if (stat.size > 50 * 1024 * 1024) throw new Error('Inbox file exceeds 50MB limit')

      const basename = path.basename(sourcePath)
      const mimeType = input.mimeType ?? mimeTypesByExtension[path.extname(basename).toLowerCase()]
      if (!mimeType) throw new Error(`Cannot infer MIME type for inbox file: ${input.filePath}`)
      const type = inboxTypeFromMime(mimeType)
      const id = createId('inbox')
      const storedFilename = sanitizeFilename(basename)
      const relativePath = path.posix.join('attachments', 'inbox', id, storedFilename)
      const targetPath = path.join(vaultPath, relativePath)
      await fs.mkdir(path.dirname(targetPath), { recursive: true })
      await fs.copyFile(sourcePath, targetPath)

      const now = nowIso()
      dataDb
        .insert(inboxItems)
        .values({
          id,
          type,
          title: input.title ?? path.basename(basename, path.extname(basename)),
          content: null,
          createdAt: now,
          modifiedAt: now,
          processingStatus: 'complete',
          captureSource: 'api',
          attachmentPath: relativePath,
          metadata: {
            originalFilename: basename,
            fileSize: stat.size,
            mimeType
          },
          ...(type === 'voice' ? { transcriptionStatus: 'pending' } : {})
        })
        .run()
      if (input.tags) setTags(dataDb, id, input.tags)
      const item = await this.get(id)
      if (!item) throw new Error('Inbox item not found after file capture')
      return item
    },

    async get(id) {
      const item = dataDb.select().from(inboxItems).where(eq(inboxItems.id, id)).get()
      return item ? toInboxRecord(dataDb, item) : null
    },

    async list(options = {}) {
      const rows = dataDb.select().from(inboxItems).orderBy(asc(inboxItems.createdAt)).all()
      const items = rows
        .filter((item) => options.includeArchived || !item.archivedAt)
        .filter((item) => options.includeSnoozed || !item.snoozedUntil)
        .map((item) => toInboxRecord(dataDb, item))
      return { items, total: items.length }
    },

    async tags() {
      const counts = new Map<string, number>()
      for (const row of dataDb.select().from(inboxItemTags).all()) {
        counts.set(row.tag, (counts.get(row.tag) ?? 0) + 1)
      }
      return Array.from(counts.entries())
        .map(([tag, count]) => ({ tag, count }))
        .sort((left, right) => right.count - left.count || left.tag.localeCompare(right.tag))
    },

    async stats() {
      const rows = dataDb.select().from(inboxItems).all()
      const activeRows = rows.filter((row) => !row.filedAt && !row.archivedAt && !row.snoozedUntil)
      const itemsByType: Record<string, number> = {}
      for (const row of activeRows) {
        itemsByType[row.type] = (itemsByType[row.type] ?? 0) + 1
      }
      return {
        totalItems: activeRows.length,
        archivedCount: rows.filter((row) => row.archivedAt).length,
        snoozedCount: rows.filter((row) => row.snoozedUntil && !row.archivedAt).length,
        viewedCount: rows.filter((row) => row.viewedAt).length,
        itemsByType
      }
    },

    async archived(options = {}) {
      const limit = Math.max(1, Math.min(200, options.limit ?? 50))
      const offset = Math.max(0, options.offset ?? 0)
      const search = options.search?.toLowerCase()
      const rows = dataDb
        .select()
        .from(inboxItems)
        .all()
        .filter((row) => row.archivedAt)
        .filter((row) => {
          if (!search) return true
          return `${row.title} ${row.content ?? ''}`.toLowerCase().includes(search)
        })
        .sort((left, right) => (right.archivedAt ?? '').localeCompare(left.archivedAt ?? ''))
      const items = rows.slice(offset, offset + limit).map((item) => toInboxRecord(dataDb, item))
      return {
        items,
        total: rows.length,
        hasMore: offset + items.length < rows.length
      }
    },

    async filingHistory(options = {}) {
      const limit = Math.max(1, Math.min(100, options.limit ?? 20))
      const entries = dataDb
        .select()
        .from(inboxItems)
        .all()
        .filter((row) => row.filedAt)
        .sort((left, right) => (right.filedAt ?? '').localeCompare(left.filedAt ?? ''))
        .slice(0, limit)
        .map((row) => ({
          id: row.id,
          itemId: row.id,
          itemType: row.type,
          itemTitle: row.title,
          filedTo: row.filedTo ?? '',
          filedAction: row.filedAction ?? 'folder',
          filedAt: row.filedAt ?? '',
          tags: tagsForItem(dataDb, row.id)
        }))
      return { entries }
    },

    async patterns() {
      const cutoffMs = Date.now() - 84 * 24 * 60 * 60 * 1000
      const rows = dataDb
        .select()
        .from(inboxItems)
        .all()
        .filter((row) => {
          const createdAt = new Date(row.createdAt).getTime()
          return Number.isFinite(createdAt) && createdAt >= cutoffMs
        })

      const timeHeatmap = Array.from({ length: 24 }, () => new Array<number>(7).fill(0))
      const typeCounts = new Map<string, number>()
      const domainCounts = new Map<string, number>()

      for (const row of rows) {
        const createdAt = new Date(row.createdAt)
        const hour = createdAt.getUTCHours()
        const dayIndex = (createdAt.getUTCDay() + 6) % 7
        timeHeatmap[hour][dayIndex] += 1
        typeCounts.set(row.type, (typeCounts.get(row.type) ?? 0) + 1)

        if (row.sourceUrl) {
          try {
            const domain = new URL(row.sourceUrl).hostname.replace(/^www\./, '')
            domainCounts.set(domain, (domainCounts.get(domain) ?? 0) + 1)
          } catch {
            // Ignore malformed source URLs captured before metadata validation.
          }
        }
      }

      const total = rows.length
      const typeDistribution = [...typeCounts.entries()]
        .sort((left, right) => right[1] - left[1])
        .map(([type, count]) => ({
          type,
          count,
          percentage: total > 0 ? Math.round((count / total) * 100) : 0,
          trend: 'stable' as const
        }))

      const tagCounts = new Map<string, number>()
      for (const row of dataDb.select().from(inboxItemTags).all()) {
        tagCounts.set(row.tag, (tagCounts.get(row.tag) ?? 0) + 1)
      }

      return {
        timeHeatmap,
        typeDistribution,
        topDomains: [...domainCounts.entries()]
          .sort((left, right) => right[1] - left[1])
          .slice(0, 10)
          .map(([domain, count]) => ({ domain, count })),
        topTags: [...tagCounts.entries()]
          .sort((left, right) => right[1] - left[1])
          .slice(0, 10)
          .map(([tag, count]) => ({ tag, count }))
      }
    },

    async getStaleThreshold() {
      return readStaleThreshold(dataDb)
    },

    async setStaleThreshold(days) {
      writeSetting(dataDb, staleThresholdKey, String(clampStaleThreshold(days)))
      return { success: true }
    },

    async update(id, input) {
      const title = input.title?.trim()
      if (input.title !== undefined && !title) throw new Error('Inbox title is required')

      const item = dataDb
        .update(inboxItems)
        .set({
          ...(input.title !== undefined ? { title } : {}),
          ...(input.content !== undefined ? { content: input.content } : {}),
          modifiedAt: nowIso()
        })
        .where(eq(inboxItems.id, id))
        .returning()
        .get()
      if (!item) throw new Error(`Inbox item not found: ${id}`)
      return toInboxRecord(dataDb, item)
    },

    async archive(id) {
      const time = nowIso()
      const item = dataDb
        .update(inboxItems)
        .set({ archivedAt: time, modifiedAt: time })
        .where(eq(inboxItems.id, id))
        .returning()
        .get()
      if (!item) throw new Error(`Inbox item not found: ${id}`)
      return toInboxRecord(dataDb, item)
    },

    async unarchive(id) {
      const time = nowIso()
      const item = dataDb
        .update(inboxItems)
        .set({ archivedAt: null, modifiedAt: time })
        .where(eq(inboxItems.id, id))
        .returning()
        .get()
      if (!item) throw new Error(`Inbox item not found: ${id}`)
      return toInboxRecord(dataDb, item)
    },

    async convertToNote(id) {
      const item = await this.get(id)
      if (!item) return { success: false, filedTo: null, error: 'Inbox item not found' }
      if (item.filedAt)
        return { success: false, filedTo: null, error: 'Item has already been filed' }

      const note = await notes.create({
        title: item.title,
        content: generateInboxNoteContent(item),
        tags: uniqueTags([...item.tags, 'inbox'])
      })
      markFiled(dataDb, id, note.path, 'note')
      return { success: true, filedTo: note.path, noteId: note.id }
    },

    async convertToTask(id) {
      const item = await this.get(id)
      if (!item) return { success: false, filedTo: null, error: 'Inbox item not found' }
      if (item.filedAt)
        return { success: false, filedTo: null, error: 'Item has already been filed' }

      const task = await tasks.create({
        title: item.title,
        description: item.content ?? item.sourceUrl,
        tags: uniqueTags([...item.tags, 'inbox'])
      })
      markFiled(dataDb, id, `task:${task.id}`, 'note')
      return { success: true, filedTo: `task:${task.id}`, taskId: task.id }
    },

    async linkToNote(id, noteId, tags = []) {
      const item = await this.get(id)
      if (!item) return { success: false, error: 'Inbox item not found' }
      if (item.filedAt) return { success: false, error: 'Item has already been filed' }

      const target = await notes.get(noteId)
      if (!target) return { success: false, error: `Target note not found: ${noteId}` }

      const inboxNote = await notes.create({
        title: item.title,
        content: generateInboxNoteContent(item),
        tags: uniqueTags([...item.tags, ...tags, 'inbox'])
      })
      const entry = captureEntry(item, inboxNote.title)
      const nextContent = /^## Inbox Captures$/m.test(target.content)
        ? target.content.replace(/^(## Inbox Captures)$/m, `$1\n${entry}`)
        : `${target.content.trimEnd()}\n\n## Inbox Captures\n\n${entry}`
      await notes.update({ id: target.id, content: nextContent })
      markFiled(dataDb, id, target.path, 'linked')
      return { success: true }
    },

    async snooze(id, until, reason) {
      const date = new Date(until)
      if (Number.isNaN(date.getTime())) throw new Error('Invalid snooze date')
      if (date <= new Date()) throw new Error('Snooze date must be in the future')

      const time = nowIso()
      const item = dataDb
        .update(inboxItems)
        .set({ snoozedUntil: until, snoozeReason: reason ?? null, modifiedAt: time })
        .where(eq(inboxItems.id, id))
        .returning()
        .get()
      if (!item) throw new Error(`Inbox item not found: ${id}`)
      return toInboxRecord(dataDb, item)
    },

    async unsnooze(id) {
      const time = nowIso()
      const item = dataDb
        .update(inboxItems)
        .set({ snoozedUntil: null, snoozeReason: null, modifiedAt: time })
        .where(eq(inboxItems.id, id))
        .returning()
        .get()
      if (!item) throw new Error(`Inbox item not found: ${id}`)
      return toInboxRecord(dataDb, item)
    },

    async snoozed() {
      const items = dataDb
        .select()
        .from(inboxItems)
        .orderBy(asc(inboxItems.snoozedUntil))
        .all()
        .filter((item) => item.snoozedUntil && !item.archivedAt)
        .map((item) => toInboxRecord(dataDb, item))
      return { items, total: items.length }
    },

    async bulkArchive(ids) {
      const errors: InboxBulkResponse['errors'] = []
      let processedCount = 0
      for (const id of ids) {
        try {
          await this.archive(id)
          processedCount += 1
        } catch (error) {
          errors.push({
            itemId: id,
            error: error instanceof Error ? error.message : 'Unknown error'
          })
        }
      }
      return { success: errors.length === 0, processedCount, errors }
    },

    async bulkSnooze(ids, until, reason) {
      const errors: InboxBulkResponse['errors'] = []
      let processedCount = 0
      for (const id of ids) {
        try {
          await this.snooze(id, until, reason)
          processedCount += 1
        } catch (error) {
          errors.push({
            itemId: id,
            error: error instanceof Error ? error.message : 'Unknown error'
          })
        }
      }
      return { success: errors.length === 0, processedCount, errors }
    },

    async bulkTag(ids, tags) {
      const normalizedTags = uniqueTags(tags)
      const errors: InboxBulkResponse['errors'] = []
      let processedCount = 0
      for (const id of ids) {
        const item = await this.get(id)
        if (!item) {
          errors.push({ itemId: id, error: 'Inbox item not found' })
          continue
        }
        for (const tag of normalizedTags) {
          const existing = dataDb
            .select()
            .from(inboxItemTags)
            .where(and(eq(inboxItemTags.itemId, id), eq(inboxItemTags.tag, tag)))
            .get()
          if (!existing) {
            dataDb
              .insert(inboxItemTags)
              .values({ id: createId('inbox_tag'), itemId: id, tag, createdAt: nowIso() })
              .run()
          }
        }
        processedCount += 1
      }
      return { success: errors.length === 0, processedCount, errors }
    },

    async deletePermanent(id) {
      dataDb.delete(inboxItems).where(eq(inboxItems.id, id)).run()
      return true
    },

    async addTag(id, tag) {
      const item = await this.get(id)
      if (!item) throw new Error(`Inbox item not found: ${id}`)
      const normalized = tag.trim()
      if (!normalized) throw new Error('Inbox tag is required')

      const existing = dataDb
        .select()
        .from(inboxItemTags)
        .where(and(eq(inboxItemTags.itemId, id), eq(inboxItemTags.tag, normalized)))
        .get()
      if (!existing) {
        dataDb
          .insert(inboxItemTags)
          .values({ id: createId('inbox_tag'), itemId: id, tag: normalized, createdAt: nowIso() })
          .run()
      }
      const updated = await this.get(id)
      if (!updated) throw new Error(`Inbox item not found: ${id}`)
      return updated
    },

    async removeTag(id, tag) {
      dataDb
        .delete(inboxItemTags)
        .where(and(eq(inboxItemTags.itemId, id), eq(inboxItemTags.tag, tag)))
        .run()
      const updated = await this.get(id)
      if (!updated) throw new Error(`Inbox item not found: ${id}`)
      return updated
    },

    async markViewed(id) {
      const time = nowIso()
      const item = dataDb
        .update(inboxItems)
        .set({ viewedAt: time, modifiedAt: time })
        .where(eq(inboxItems.id, id))
        .returning()
        .get()
      if (!item) throw new Error(`Inbox item not found: ${id}`)
      return toInboxRecord(dataDb, item)
    }
  }
}
