/**
 * Tags with fields: schema snapshot and edits, impact previews, object search,
 * "Linked here", categories, icons, pins and ordering.
 *
 * Mirrors desktop's `main/tags/` (schema/{commands,edit,read,impact}.ts,
 * objects.ts) and `ipc/tags-handlers.ts`. The pure schema logic
 * (`resolveTagSchemas`, `applySchemaEdit`) is shared through
 * `@memry/app-core/tag-schema`. Membership ("is this note an object of the
 * tag") is read from the note files' frontmatter tags, which are the header
 * tags, because the CLI does not maintain the index database.
 *
 * Sync: a tag definition is exempt from desktop's dirty sweep, so a write the
 * CLI makes reaches other devices only if it leaves an intent. Each write
 * inserts a `sync_intents` row in the same transaction; desktop replays the row
 * when its sync runtime starts (`drainPendingSyncIntents`).
 */
import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  isNull,
  sql,
  type AnyColumn,
  type SQL
} from 'drizzle-orm'
import {
  propertyDefinitions,
  syncIntents,
  tagDefinitions,
  taskTags,
  tasks
} from '@memry/db-schema/data-schema'
import { noteTags } from '@memry/db-schema/index-schema'
import { parseRelationValue } from '@memry/contracts/relation-uri'
import type { PropertyType } from '@memry/contracts/property-types'
import type { ResolvedTag } from '@memry/contracts/tag-schema'
import type { ImpactQuery, ImpactResult, NewFieldSpec } from '@memry/contracts/tag-schema-api'
import type {
  GetLinkedHereInput,
  LinkedHereGroup,
  LinkedNoteItem,
  LinkedTaskItem,
  ObjectMatch,
  SearchObjectsResponse
} from '@memry/contracts/tag-objects-api'
import {
  applySchemaEdit,
  canonicalFieldName,
  descendantsOf,
  parseSchemaColumn,
  primaryObjectTag,
  resolveTagSchemas,
  serializeSchema,
  type PropertyTypeLookup,
  type SchemaBodyEdit,
  type SchemaEditError,
  type TagDefinitionInput
} from '@memry/app-core/tag-schema'
import type { NoteRecord } from '@memry/app-core/service-types'
import { tagKey, foldTag } from '@memry/shared/tag-fold'
import { plainVersionedMap } from '@memry/shared/versioned'
import { utcNow } from '@memry/shared/utc'
import { tagCategories } from '@memry/db-schema/schema/tag-categories'
import { randomUUID } from 'node:crypto'
import {
  TAG_COLOR_PALETTE,
  DEFAULT_OPTION_COLOR,
  MAX_NOTES,
  tagIs,
  tagIn,
  schemaEditFailure,
  parseOptions,
  foldForSearch,
  matchRank,
  TEXT_LIKE,
  subtitleFor,
  fieldOwner
} from './tag-schema-support.ts'
import {
  NEW_FIELD_TYPES,
  type NewFieldType,
  type TagCategoryRecord,
  type TagFieldInput,
  type TagSchemaEdit,
  type TagSchemaEditResult,
  type TagSchemaOverview,
  type TagSchemaService
} from './tag-schema-types.ts'
import type { DataDb, IndexDb } from './database.ts'
import type { NotesService } from './notes.ts'
import type { PropertiesService } from './properties.ts'
import type { TemplatesService } from './templates.ts'

export function createTagSchemaService({
  dataDb,
  indexDb,
  notes,
  properties,
  templates
}: {
  dataDb: DataDb
  indexDb: IndexDb
  notes: NotesService
  properties: PropertiesService
  templates: TemplatesService
}): TagSchemaService {
  const queueIntent = (
    type: 'tag_definition' | 'tag_category' | 'property_definition',
    itemId: string,
    op: 'create' | 'update' | 'delete'
  ): void => {
    dataDb.insert(syncIntents).values({ type, itemId, op, args: '[]', createdAt: new Date() }).run()
  }

  const definitionName = (tag: string): string =>
    dataDb
      .select({ name: tagDefinitions.name })
      .from(tagDefinitions)
      .where(tagIs(tagDefinitions.name, tag.trim()))
      .get()?.name ?? tagKey(tag)

  const getOrCreateTag = (name: string): void => {
    const existing = dataDb
      .select({ name: tagDefinitions.name })
      .from(tagDefinitions)
      .where(tagIs(tagDefinitions.name, name.trim()))
      .get()
    if (existing) return
    const count = dataDb.select().from(tagDefinitions).all().length
    dataDb
      .insert(tagDefinitions)
      .values({
        name: name.trim(),
        color: TAG_COLOR_PALETTE[count % TAG_COLOR_PALETTE.length],
        colorAuthored: false
      })
      .run()
  }

  const propertyDefinitionRows = () => dataDb.select().from(propertyDefinitions).all()

  const propertyTypes = (): PropertyTypeLookup => {
    const byName = new Map(propertyDefinitionRows().map((row) => [row.name, row]))
    return {
      get(name) {
        const row = byName.get(name)
        if (!row) return undefined
        const type = row.type as PropertyType
        const parsed = parseOptions(row.options)
        if (type === 'status' || type === 'project') return { type }
        if (type === 'date') {
          const show =
            parsed && typeof parsed === 'object' && !Array.isArray(parsed)
              ? (parsed as { showOnCalendar?: unknown }).showOnCalendar
              : undefined
          return { type, showOnCalendar: show === true }
        }
        return {
          type,
          options: Array.isArray(parsed) ? (parsed as Array<{ value: string; color: string }>) : []
        }
      }
    }
  }

  const loadResolved = (): Map<string, ResolvedTag> => {
    const defs = new Map<string, TagDefinitionInput>()
    for (const row of dataDb.select().from(tagDefinitions).all()) {
      defs.set(tagKey(row.name), {
        name: row.name,
        color: row.color,
        icon: row.icon,
        schema: parseSchemaColumn(row.schema)
      })
    }
    return resolveTagSchemas(defs, propertyTypes())
  }

  const loadNotes = (): Promise<NoteRecord[]> => notes.list({ limit: MAX_NOTES })

  const headerHas = (note: NoteRecord, keys: ReadonlySet<string>): boolean =>
    note.tags.some((tag) => keys.has(tagKey(tag)))

  const taskIdsWithTags = (keys: readonly string[]): string[] =>
    keys.length === 0
      ? []
      : dataDb
          .selectDistinct({ taskId: taskTags.taskId })
          .from(taskTags)
          .where(tagIn(taskTags.tag, keys))
          .all()
          .map((row) => row.taskId)

  const taskFieldMaps = (): Array<{ id: string; fields: Record<string, unknown> }> =>
    dataDb
      .select({ id: tasks.id, fields: tasks.fields })
      .from(tasks)
      .where(isNotNull(tasks.fields))
      .all()
      .map((row) => ({ id: row.id, fields: plainVersionedMap(row.fields) }))

  const family = (tag: string, resolved: Map<string, ResolvedTag>): string[] | null => {
    const key = tagKey(tag)
    if (!resolved.get(key)?.hasFields) return null
    return [key, ...descendantsOf(key, resolved)]
  }

  const planEdit = (key: string, edit: SchemaBodyEdit) => {
    const row = dataDb
      .select({ schema: tagDefinitions.schema })
      .from(tagDefinitions)
      .where(tagIs(tagDefinitions.name, key))
      .get()
    const parsed = parseSchemaColumn(row?.schema ?? null)
    if (parsed.kind === 'unreadable') throw schemaEditFailure({ code: 'unreadable-schema' })
    const result = applySchemaEdit(parsed.kind === 'ok' ? parsed.schema : null, edit, {
      tag: key,
      resolved: loadResolved()
    })
    if (!result.ok) throw schemaEditFailure(result.error)
    return result
  }

  const saveEdit = (tag: string, edit: SchemaBodyEdit): boolean => {
    const key = tagKey(tag)
    const result = planEdit(key, edit)
    if (!result.changed) return false
    dataDb.transaction(() => {
      getOrCreateTag(key)
      dataDb
        .update(tagDefinitions)
        .set({ schema: serializeSchema(result.next) })
        .where(tagIs(tagDefinitions.name, key))
        .run()
      queueIntent('tag_definition', definitionName(key), 'update')
    })
    return true
  }

  const knownFieldNames = (): string[] => {
    const names = propertyDefinitionRows().map((row) => row.name)
    for (const tag of loadResolved().values()) {
      for (const field of tag.ownFields) names.push(field.name)
    }
    return names
  }

  const ensureDefinition = async (name: string, field: TagFieldInput): Promise<void> => {
    if (field.type === 'relation') return
    if (propertyDefinitionRows().some((row) => row.name === name)) return
    const options =
      field.options && (field.type === 'select' || field.type === 'multiselect')
        ? JSON.stringify(field.options.map((value) => ({ value, color: DEFAULT_OPTION_COLOR })))
        : null
    await properties.createDefinition({ name, type: field.type, options })
    queueIntent('property_definition', name, 'update')
  }

  const requireRelation = (
    relation: { target: string; many: boolean; inverse: string | null } | undefined
  ) => {
    if (!relation?.target.trim()) throw new Error('Choose which tag this relation points to')
    return {
      target: tagKey(relation.target),
      many: relation.many,
      inverse: relation.inverse?.trim() || null
    }
  }

  const resultFor = (tag: string, changed: boolean): TagSchemaEditResult => ({
    tag: tagKey(tag),
    changed,
    schema: loadResolved().get(tagKey(tag)) ?? null
  })

  return {
    async snapshot() {
      const resolved = loadResolved()
      const objects: Record<string, string> = {}
      for (const note of await loadNotes()) {
        const primary = primaryObjectTag(note.tags, resolved)
        if (primary) objects[note.id] = primary
      }
      return { tags: Object.fromEntries(resolved), objects }
    },

    async schemaOf(tag) {
      const resolved = loadResolved().get(tagKey(tag))
      if (!resolved) throw new Error(`Tag has no fields: ${tag}`)
      return resolved
    },

    async edit(edit) {
      switch (edit.kind) {
        case 'add-field': {
          const { field } = edit
          if (!(NEW_FIELD_TYPES as readonly string[]).includes(field.type)) {
            throw new Error(
              `Unknown field type: ${field.type}. Allowed: ${NEW_FIELD_TYPES.join(', ')}`
            )
          }
          const relation = field.type === 'relation' ? requireRelation(field.relation) : null
          const name = canonicalFieldName(field.name, knownFieldNames()).name
          const body: SchemaBodyEdit = {
            kind: 'add-field',
            field: { name, relation },
            ...(edit.index !== undefined ? { index: edit.index } : {})
          }
          planEdit(tagKey(edit.tag), body)
          await ensureDefinition(name, field)
          return resultFor(edit.tag, saveEdit(edit.tag, body))
        }
        case 'remove-field':
          return resultFor(edit.tag, saveEdit(edit.tag, { kind: 'remove-field', name: edit.name }))
        case 'move-field':
          return resultFor(
            edit.tag,
            saveEdit(edit.tag, { kind: 'move-field', name: edit.name, toIndex: edit.toIndex })
          )
        case 'set-relation':
          return resultFor(
            edit.tag,
            saveEdit(edit.tag, {
              kind: 'set-relation',
              name: edit.name,
              relation: requireRelation(edit.relation)
            })
          )
        case 'set-template': {
          if (edit.template && !(await templates.get(edit.template.id))) {
            throw new Error(`Template not found: ${edit.template.id}`)
          }
          return resultFor(
            edit.tag,
            saveEdit(edit.tag, { kind: 'set-template', template: edit.template })
          )
        }
        case 'set-extends':
          return resultFor(
            edit.tag,
            saveEdit(edit.tag, { kind: 'set-extends', parent: edit.parent })
          )
      }
    },

    async impact(query) {
      const resolved = loadResolved()
      const members = (tag: string): Set<string> =>
        new Set([tagKey(tag), ...descendantsOf(tag, resolved)])
      const fieldNames = (tag: ResolvedTag | undefined): string[] =>
        tag?.effectiveFields.map((f) => f.name) ?? []
      const allNotes = await loadNotes()
      const objectsOf = (keys: ReadonlySet<string>) =>
        allNotes.filter((note) => headerHas(note, keys))

      switch (query.kind) {
        case 'remove-field': {
          const keys = members(query.tag)
          const objects = objectsOf(keys)
          const filledNotes = objects.filter((note) => query.name in note.properties).length
          const taskIds = new Set(taskIdsWithTags([...keys]))
          const filledTasks = taskFieldMaps().filter(
            (task) => taskIds.has(task.id) && query.name in task.fields
          ).length
          const filled = filledNotes + filledTasks
          return { kind: 'remove-field', filled, empty: objects.length + taskIds.size - filled }
        }
        case 'rename-field':
          return {
            kind: 'rename-field',
            notes: allNotes.filter((note) => query.name in note.properties).length,
            tasks: taskFieldMaps().filter((task) => query.name in task.fields).length,
            tags: [...resolved.values()]
              .filter((tag) => tag.ownFields.some((f) => f.name === query.name))
              .map((tag) => tag.key)
          }
        case 'delete-tag': {
          const key = tagKey(query.tag)
          const tag = resolved.get(key)
          const objects = objectsOf(new Set([key]))
          const names = new Set(fieldNames(tag))
          const template = tag?.template && !tag.template.inheritedFrom ? tag.template : null
          return {
            kind: 'delete-tag',
            notes: objects.length,
            tasks: taskIdsWithTags([key]).length,
            values: objects.reduce(
              (sum, note) => sum + Object.keys(note.properties).filter((n) => names.has(n)).length,
              0
            ),
            fields: tag?.ownFields.length ?? 0,
            templateName: template ? ((await templates.get(template.id))?.name ?? null) : null
          }
        }
        case 'set-extends': {
          const tag = resolved.get(tagKey(query.tag))
          const own = new Set(tag?.ownFields.map((f) => f.name.toLowerCase()) ?? [])
          const before = fieldNames(tag).filter((n) => !own.has(n.toLowerCase()))
          const parent = query.parent === null ? undefined : resolved.get(tagKey(query.parent))
          const after = fieldNames(parent).filter((n) => !own.has(n.toLowerCase()))
          return {
            kind: 'set-extends',
            notes: objectsOf(members(query.tag)).length,
            gained: after.filter((n) => !before.includes(n)),
            lost: before.filter((n) => !after.includes(n))
          }
        }
        case 'become-objects':
          return { kind: 'become-objects', notes: objectsOf(members(query.tag)).length }
      }
    },

    async objects(input) {
      const resolved = loadResolved()
      const candidates = input.tag
        ? (family(input.tag, resolved) ?? [])
        : [...resolved.values()].filter((tag) => tag.hasFields).map((tag) => tag.key)
      const candidateSet = new Set(candidates)
      const query = foldForSearch(input.query.trim())
      const allNotes = await loadNotes()
      const byId = new Map(allNotes.map((note) => [note.id, note]))
      const primary = (note: NoteRecord): string | null =>
        note.tags.map(tagKey).find((key) => candidateSet.has(key)) ?? null

      const ranked = allNotes
        .flatMap((note) => {
          if (!primary(note)) return []
          const rank = matchRank(note.title, query)
          return rank === null ? [] : [{ note, rank }]
        })
        .sort((a, b) => a.rank - b.rank || b.note.modifiedAt.localeCompare(a.note.modifiedAt))
        .slice(0, input.limit)

      const matches: ObjectMatch[] = ranked.map(({ note }) => {
        const tag = primary(note)!
        const groupTag = resolved.get(tag)?.ancestors.at(-1) ?? tag
        return {
          noteId: note.id,
          title: note.title,
          tag,
          groupTag,
          viaTag: tag === groupTag ? null : tag,
          subtitle: subtitleFor(note.properties, resolved.get(tag), (id) => byId.get(id)?.title),
          modified: note.modifiedAt
        }
      })
      return { matches, complete: true }
    },

    async linkedHere(input) {
      const resolved = loadResolved()
      const uri = `memry://note/${input.noteId}`
      const filter = (field: string): string => `${field} contains "${uri}"`
      const groups: LinkedHereGroup[] = []
      const allNotes = await loadNotes()
      const byNewest = (a: NoteRecord, b: NoteRecord): number =>
        b.modifiedAt.localeCompare(a.modifiedAt)
      const toItem = (note: NoteRecord): LinkedNoteItem => ({
        noteId: note.id,
        title: note.title,
        date: note.journalDate,
        snippet: note.snippet || null
      })

      const relationGroups = new Map<
        string,
        { sourceTag: string; field: string; label: string; notes: NoteRecord[] }
      >()
      for (const note of allNotes) {
        if (note.id === input.noteId) continue
        for (const [field, value] of Object.entries(note.properties)) {
          if (!parseRelationValue(value).some((r) => r.kind === 'note' && r.id === input.noteId)) {
            continue
          }
          const owner = fieldOwner(note.tags, field, resolved, true)
          const sourceTag = owner?.tag ?? ''
          const key = JSON.stringify([sourceTag, field])
          const group = relationGroups.get(key) ?? {
            sourceTag,
            field,
            label: owner?.label ?? field,
            notes: []
          }
          group.notes.push(note)
          relationGroups.set(key, group)
        }
      }
      for (const group of relationGroups.values()) {
        groups.push({
          kind: 'relation',
          sourceTag: group.sourceTag,
          field: group.field,
          label: group.label,
          total: group.notes.length,
          items: group.notes.sort(byNewest).slice(0, input.limitPerGroup).map(toItem),
          filter: filter(group.field)
        })
      }

      const escaped = input.noteId.replace(/[\\%_]/g, (c) => `\\${c}`)
      const taskRows = dataDb
        .select({
          id: tasks.id,
          title: tasks.title,
          dueDate: tasks.dueDate,
          completedAt: tasks.completedAt,
          fields: tasks.fields
        })
        .from(tasks)
        .where(
          and(
            isNull(tasks.archivedAt),
            sql`${tasks.fields} LIKE ${`%memry://note/${escaped}%`} ESCAPE '\\'`
          )
        )
        .all()
      const tagsOfTask = new Map<string, string[]>()
      if (taskRows.length > 0) {
        for (const row of dataDb
          .select({ taskId: taskTags.taskId, tag: taskTags.tag })
          .from(taskTags)
          .where(
            inArray(
              taskTags.taskId,
              taskRows.map((task) => task.id)
            )
          )
          .all()) {
          tagsOfTask.set(row.taskId, [...(tagsOfTask.get(row.taskId) ?? []), row.tag])
        }
      }
      const taskGroups = new Map<string, { tag: string; field: string; items: LinkedTaskItem[] }>()
      for (const task of taskRows) {
        for (const [field, value] of Object.entries(plainVersionedMap(task.fields))) {
          if (!parseRelationValue(value).some((r) => r.kind === 'note' && r.id === input.noteId)) {
            continue
          }
          const tag = fieldOwner(tagsOfTask.get(task.id) ?? [], field, resolved, false)?.tag ?? ''
          const key = JSON.stringify([tag, field])
          const group = taskGroups.get(key) ?? { tag, field, items: [] }
          group.items.push({
            taskId: task.id,
            title: task.title,
            dueDate: task.dueDate,
            completed: task.completedAt !== null
          })
          taskGroups.set(key, group)
        }
      }
      for (const group of taskGroups.values()) {
        const items = group.items.sort(
          (a, b) =>
            Number(a.completed) - Number(b.completed) ||
            (a.dueDate ?? '\uffff').localeCompare(b.dueDate ?? '\uffff')
        )
        groups.push({
          kind: 'task-field',
          tag: group.tag,
          field: group.field,
          total: items.length,
          items: items.slice(0, input.limitPerGroup),
          filter: filter(group.field)
        })
      }

      const backlinkIds = new Set(
        (await notes.getLinks(input.noteId)).backlinks.map((link) => link.id)
      )
      const mentions = allNotes
        .filter((note) => note.id !== input.noteId && backlinkIds.has(note.id))
        .sort(byNewest)
      if (mentions.length > 0) {
        groups.push({
          kind: 'mentions',
          total: mentions.length,
          items: mentions.slice(0, input.limitPerGroup).map(toItem)
        })
      }
      return groups
    },

    async setIcon(tag, icon) {
      dataDb.transaction(() => {
        getOrCreateTag(tag)
        dataDb
          .update(tagDefinitions)
          .set({ icon })
          .where(tagIs(tagDefinitions.name, tag.trim()))
          .run()
        queueIntent('tag_definition', definitionName(tag), 'update')
      })
      return { tag: tagKey(tag), icon }
    },

    async pin(tag, noteId) {
      return setPinned(tag, noteId, utcNow())
    },

    async unpin(tag, noteId) {
      return setPinned(tag, noteId, null)
    },

    async reorder({ tags, category }) {
      if (tags.length === 0) throw new Error('At least one tag is required')
      if (category) {
        const exists = dataDb
          .select({ id: tagCategories.id })
          .from(tagCategories)
          .where(and(eq(tagCategories.id, category), isNull(tagCategories.deletedAt)))
          .get()
        if (!exists) throw new Error(`Tag category not found: ${category}`)
      }
      const assigned: Array<{ tag: string; categoryId: string | null; sortOrder: number }> = []
      dataDb.transaction(() => {
        tags.forEach((tag, sortOrder) => {
          getOrCreateTag(tag)
          const current = dataDb
            .select({ categoryId: tagDefinitions.categoryId })
            .from(tagDefinitions)
            .where(tagIs(tagDefinitions.name, tag.trim()))
            .get()
          const categoryId = category === undefined ? (current?.categoryId ?? null) : category
          dataDb
            .update(tagDefinitions)
            .set({ categoryId, sortOrder })
            .where(tagIs(tagDefinitions.name, tag.trim()))
            .run()
          queueIntent('tag_definition', definitionName(tag), 'update')
          assigned.push({ tag: tagKey(tag), categoryId, sortOrder })
        })
      })
      return { success: true, tags: assigned }
    },

    categories: {
      async list() {
        return dataDb
          .select({
            id: tagCategories.id,
            name: tagCategories.name,
            sortOrder: tagCategories.sortOrder,
            tagCount: sql<number>`(
              SELECT COUNT(*) FROM ${tagDefinitions}
              WHERE ${tagDefinitions.categoryId} = ${tagCategories.id}
            )`
          })
          .from(tagCategories)
          .where(isNull(tagCategories.deletedAt))
          .orderBy(asc(tagCategories.sortOrder), asc(tagCategories.name))
          .all()
      },

      async create(name) {
        const trimmed = name.trim()
        if (!trimmed) throw new Error('Category name is required')
        const max = dataDb
          .select({ max: sql<number | null>`MAX(${tagCategories.sortOrder})` })
          .from(tagCategories)
          .where(isNull(tagCategories.deletedAt))
          .get()
        const sortOrder = (max?.max ?? -1) + 1
        const id = randomUUID()
        const now = utcNow()
        dataDb.transaction(() => {
          dataDb
            .insert(tagCategories)
            .values({ id, name: trimmed, sortOrder, clock: null, createdAt: now, updatedAt: now })
            .run()
          queueIntent('tag_category', id, 'create')
        })
        return { id, name: trimmed, sortOrder, tagCount: 0 }
      },

      async rename(id, name) {
        const trimmed = name.trim()
        if (!trimmed) throw new Error('Category name is required')
        requireCategory(id)
        dataDb.transaction(() => {
          dataDb
            .update(tagCategories)
            .set({ name: trimmed, updatedAt: utcNow() })
            .where(eq(tagCategories.id, id))
            .run()
          queueIntent('tag_category', id, 'update')
        })
        return { success: true }
      },

      async delete(id) {
        requireCategory(id)
        dataDb.transaction(() => {
          const affected = dataDb
            .select({ name: tagDefinitions.name })
            .from(tagDefinitions)
            .where(eq(tagDefinitions.categoryId, id))
            .all()
          dataDb
            .update(tagDefinitions)
            .set({ categoryId: null })
            .where(eq(tagDefinitions.categoryId, id))
            .run()
          dataDb
            .update(tagCategories)
            .set({ deletedAt: utcNow(), updatedAt: utcNow() })
            .where(eq(tagCategories.id, id))
            .run()
          for (const tag of affected) queueIntent('tag_definition', tag.name, 'update')
          queueIntent('tag_category', id, 'delete')
        })
        return { success: true }
      },

      async reorder(ids) {
        if (ids.length === 0) throw new Error('At least one category id is required')
        ids.forEach(requireCategory)
        const now = utcNow()
        dataDb.transaction(() => {
          ids.forEach((id, sortOrder) => {
            dataDb
              .update(tagCategories)
              .set({ sortOrder, updatedAt: now })
              .where(and(eq(tagCategories.id, id), isNull(tagCategories.deletedAt)))
              .run()
            queueIntent('tag_category', id, 'update')
          })
        })
        return { success: true }
      }
    }
  }

  function requireCategory(id: string): void {
    const row = dataDb
      .select({ id: tagCategories.id })
      .from(tagCategories)
      .where(and(eq(tagCategories.id, id), isNull(tagCategories.deletedAt)))
      .get()
    if (!row) throw new Error(`Tag category not found: ${id}`)
  }

  // Pins live in the index database only (desktop `pinNoteToTag`), and the CLI
  // does not write note_tags rows, so a note desktop has not indexed cannot be
  // pinned from here.
  async function setPinned(tag: string, noteId: string, pinnedAt: string | null) {
    const note = await notes.get(noteId)
    if (!note) throw new Error(`Note not found: ${noteId}`)
    if (!note.tags.some((t) => tagKey(t) === tagKey(tag))) {
      throw new Error(`Note ${noteId} does not have the tag: ${tag}`)
    }
    const result = indexDb
      .update(noteTags)
      .set({ pinnedAt })
      .where(and(eq(noteTags.noteId, note.id), tagIs(noteTags.tag, tag)))
      .run()
    if (result.changes === 0) {
      throw new Error(
        'This note is not in the search index yet. Open it in the Memry desktop app, then try again'
      )
    }
    return { success: true as const }
  }
}

export { foldForSearch } from './tag-schema-support.ts'
export { NEW_FIELD_TYPES } from './tag-schema-types.ts'
export type {
  NewFieldType,
  TagCategoryRecord,
  TagFieldInput,
  TagSchemaEdit,
  TagSchemaEditResult,
  TagSchemaOverview,
  TagSchemaService
} from './tag-schema-types.ts'
