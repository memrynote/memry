import { and, eq } from 'drizzle-orm'
import { inboxItemTags, tagDefinitions, taskTags } from '@memry/db-schema/data-schema'
import type { DrizzleDb as DataDb } from '@memry/db-schema/drizzle-db'
import { createId } from './ids.ts'
import type { NotesService } from './service-types.ts'

export interface TagRecord {
  name: string
  color: string
  noteCount: number
  taskCount: number
  inboxCount: number
  totalCount: number
}

export interface TaggedNoteRecord {
  id: string
  path: string
  title: string
  created: string
  modified: string
  tags: string[]
  wordCount: number
  isPinned: false
  pinnedAt: null
  emoji: string | null
}

export interface NotesByTagResponse {
  tag: string
  color: string
  count: number
  pinnedNotes: TaggedNoteRecord[]
  unpinnedNotes: TaggedNoteRecord[]
}

export interface TagsService {
  list(): Promise<TagRecord[]>
  notes(name: string): Promise<NotesByTagResponse>
  setColor(name: string, color: string): Promise<TagRecord>
  rename(from: string, to: string): Promise<TagRecord>
  removeFromNote(noteId: string, name: string): Promise<{ success: boolean }>
  merge(source: string, target: string): Promise<{ success: boolean; affectedItems: number }>
  delete(name: string): Promise<boolean>
}

const DEFAULT_TAG_COLOR = '#6b7280'

function normalizeTag(tag: string): string {
  return tag.trim()
}

function tagKey(tag: string): string {
  return normalizeTag(tag).toLowerCase()
}

function countUniqueTags(tags: string[]): string[] {
  return [...new Map(tags.map((tag) => [tagKey(tag), normalizeTag(tag)])).values()].filter(Boolean)
}

function bump(
  map: Map<string, TagRecord>,
  name: string,
  field: 'noteCount' | 'taskCount' | 'inboxCount'
) {
  const normalized = normalizeTag(name)
  if (!normalized) return
  const key = tagKey(normalized)
  const existing =
    map.get(key) ??
    ({
      name: normalized,
      color: DEFAULT_TAG_COLOR,
      noteCount: 0,
      taskCount: 0,
      inboxCount: 0,
      totalCount: 0
    } satisfies TagRecord)
  existing[field] += 1
  existing.totalCount += 1
  map.set(key, existing)
}

function replaceTag(tags: string[], from: string, to: string): string[] {
  const fromKey = tagKey(from)
  return countUniqueTags(tags.map((tag) => (tagKey(tag) === fromKey ? to : tag)))
}

function removeTag(tags: string[], name: string): string[] {
  const nameKey = tagKey(name)
  return countUniqueTags(tags.filter((tag) => tagKey(tag) !== nameKey))
}

function hasTag(tags: string[], name: string): boolean {
  const nameKey = tagKey(name)
  return tags.some((tag) => tagKey(tag) === nameKey)
}

async function allTaggedNotes(notes: NotesService) {
  const regularNotes = await notes.list({ limit: 10000 })
  const journalNotes = await notes.list({ journalOnly: true, limit: 10000 })
  return [...regularNotes, ...journalNotes]
}

export function createTagsService({
  dataDb,
  notes
}: {
  dataDb: DataDb
  notes: NotesService
}): TagsService {
  return {
    async list() {
      const tagsByKey = new Map<string, TagRecord>()

      for (const note of await allTaggedNotes(notes)) {
        for (const tag of countUniqueTags(note.tags)) {
          bump(tagsByKey, tag, 'noteCount')
        }
      }

      const taskRows = dataDb.select().from(taskTags).all()
      for (const row of taskRows) {
        bump(tagsByKey, row.tag, 'taskCount')
      }

      const inboxRows = dataDb.select().from(inboxItemTags).all()
      const inboxPairs = new Set<string>()
      for (const row of inboxRows) {
        const pair = `${row.itemId}:${tagKey(row.tag)}`
        if (inboxPairs.has(pair)) continue
        inboxPairs.add(pair)
        bump(tagsByKey, row.tag, 'inboxCount')
      }

      for (const definition of dataDb.select().from(tagDefinitions).all()) {
        const key = tagKey(definition.name)
        const existing =
          tagsByKey.get(key) ??
          ({
            name: definition.name,
            color: definition.color,
            noteCount: 0,
            taskCount: 0,
            inboxCount: 0,
            totalCount: 0
          } satisfies TagRecord)
        existing.color = definition.color
        tagsByKey.set(key, existing)
      }

      return [...tagsByKey.values()].sort((a, b) => a.name.localeCompare(b.name))
    },

    async notes(name) {
      const normalized = normalizeTag(name)
      if (!normalized) throw new Error('Tag name is required')
      const tag = (await this.list()).find((item) => tagKey(item.name) === tagKey(normalized))
      const taggedNotes = (await allTaggedNotes(notes))
        .filter((note) => hasTag(note.tags, normalized))
        .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))
        .map((note) => ({
          id: note.id,
          path: note.path,
          title: note.title,
          created: note.createdAt,
          modified: note.modifiedAt,
          tags: note.tags,
          wordCount: note.wordCount,
          isPinned: false as const,
          pinnedAt: null,
          emoji: note.emoji
        }))
      return {
        tag: normalized,
        color: tag?.color ?? DEFAULT_TAG_COLOR,
        count: taggedNotes.length,
        pinnedNotes: [],
        unpinnedNotes: taggedNotes
      }
    },

    async setColor(name, color) {
      const normalized = normalizeTag(name)
      if (!normalized) throw new Error('Tag name is required')
      dataDb
        .insert(tagDefinitions)
        .values({ name: normalized, color })
        .onConflictDoUpdate({ target: tagDefinitions.name, set: { color } })
        .run()

      return (
        (await this.list()).find((tag) => tagKey(tag.name) === tagKey(normalized)) ?? {
          name: normalized,
          color,
          noteCount: 0,
          taskCount: 0,
          inboxCount: 0,
          totalCount: 0
        }
      )
    },

    async rename(from, to) {
      const fromName = normalizeTag(from)
      const toName = normalizeTag(to)
      if (!fromName || !toName) throw new Error('Both source and target tag names are required')

      for (const note of await allTaggedNotes(notes)) {
        if (!note.tags.some((tag) => tagKey(tag) === tagKey(fromName))) continue
        await notes.update({ id: note.id, tags: replaceTag(note.tags, fromName, toName) })
      }

      const matchingTaskRows = dataDb
        .select()
        .from(taskTags)
        .all()
        .filter((row) => tagKey(row.tag) === tagKey(fromName))
      for (const row of matchingTaskRows) {
        dataDb
          .delete(taskTags)
          .where(and(eq(taskTags.taskId, row.taskId), eq(taskTags.tag, row.tag)))
          .run()
        dataDb
          .insert(taskTags)
          .values({ taskId: row.taskId, tag: toName })
          .onConflictDoNothing()
          .run()
      }

      const matchingInboxRows = dataDb
        .select()
        .from(inboxItemTags)
        .all()
        .filter((row) => tagKey(row.tag) === tagKey(fromName))
      const inboxTargets = new Set(matchingInboxRows.map((row) => row.itemId))
      for (const row of matchingInboxRows) {
        dataDb.delete(inboxItemTags).where(eq(inboxItemTags.id, row.id)).run()
      }
      for (const itemId of inboxTargets) {
        const existing = dataDb
          .select()
          .from(inboxItemTags)
          .all()
          .some((row) => row.itemId === itemId && tagKey(row.tag) === tagKey(toName))
        if (existing) continue
        dataDb
          .insert(inboxItemTags)
          .values({
            id: createId('inbox_tag'),
            itemId,
            tag: toName,
            createdAt: new Date().toISOString()
          })
          .run()
      }

      const oldDefinition = dataDb
        .select()
        .from(tagDefinitions)
        .where(eq(tagDefinitions.name, fromName))
        .get()
      dataDb.delete(tagDefinitions).where(eq(tagDefinitions.name, fromName)).run()
      dataDb
        .insert(tagDefinitions)
        .values({ name: toName, color: oldDefinition?.color ?? DEFAULT_TAG_COLOR })
        .onConflictDoUpdate({
          target: tagDefinitions.name,
          set: { color: oldDefinition?.color ?? DEFAULT_TAG_COLOR }
        })
        .run()

      return (
        (await this.list()).find((tag) => tagKey(tag.name) === tagKey(toName)) ?? {
          name: toName,
          color: oldDefinition?.color ?? DEFAULT_TAG_COLOR,
          noteCount: 0,
          taskCount: 0,
          inboxCount: 0,
          totalCount: 0
        }
      )
    },

    async removeFromNote(noteId, name) {
      const note = await notes.get(noteId)
      if (!note) throw new Error(`Note not found: ${noteId}`)
      await notes.update({ id: note.id, tags: removeTag(note.tags, name) })
      return { success: true }
    },

    async merge(source, target) {
      const sourceName = normalizeTag(source)
      const targetName = normalizeTag(target)
      if (!sourceName || !targetName)
        throw new Error('Both source and target tag names are required')
      if (tagKey(sourceName) === tagKey(targetName)) {
        return { success: false, affectedItems: 0 }
      }
      const affectedItems =
        (await this.list()).find((tag) => tagKey(tag.name) === tagKey(sourceName))?.totalCount ?? 0
      await this.rename(sourceName, targetName)
      return { success: true, affectedItems }
    },

    async delete(name) {
      const normalized = normalizeTag(name)
      if (!normalized) throw new Error('Tag name is required')

      for (const note of await allTaggedNotes(notes)) {
        if (!note.tags.some((tag) => tagKey(tag) === tagKey(normalized))) continue
        await notes.update({ id: note.id, tags: removeTag(note.tags, normalized) })
      }

      for (const row of dataDb
        .select()
        .from(taskTags)
        .all()
        .filter((row) => tagKey(row.tag) === tagKey(normalized))) {
        dataDb
          .delete(taskTags)
          .where(and(eq(taskTags.taskId, row.taskId), eq(taskTags.tag, row.tag)))
          .run()
      }

      for (const row of dataDb
        .select()
        .from(inboxItemTags)
        .all()
        .filter((row) => tagKey(row.tag) === tagKey(normalized))) {
        dataDb.delete(inboxItemTags).where(eq(inboxItemTags.id, row.id)).run()
      }

      dataDb.delete(tagDefinitions).where(eq(tagDefinitions.name, normalized)).run()
      return true
    }
  }
}
