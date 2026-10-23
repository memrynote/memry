import fs from 'node:fs/promises'
import path from 'node:path'
import { and, inArray, isNull } from 'drizzle-orm'
import matter from 'gray-matter'
import {
  DEFAULT_STATUS_CATEGORIES,
  PropertyTypes,
  STATUS_CATEGORY_KEYS,
  parseStatusCategories,
  type SelectOption,
  type StatusCategories,
  type StatusCategoryKey
} from '@memry/contracts/property-types'
import type { ResolvedRelationRef } from '@memry/contracts/properties-api'
import {
  decodeExternalEventRelationId,
  parseRelationUri,
  type RelationKind
} from '@memry/contracts/relation-uri'
import {
  calendarEvents,
  calendarExternalEvents,
  canvases,
  noteMetadata,
  tasks,
  type PropertyDefinition
} from '@memry/db-schema/data-schema'
import type { DataDb } from './database.ts'
import type { NotesService } from './notes.ts'
import { getMemryDir } from './paths.ts'
import type { PropertiesService } from './properties.ts'

export interface PropertyToolsService {
  ensureDefinition(name: string, type: string): Promise<PropertyDefinition>
  addOption(
    name: string,
    option: { value: string; color?: string },
    categoryKey?: string
  ): Promise<PropertyDefinition>
  removeOption(name: string, value: string): Promise<PropertyDefinition>
  renameOption(name: string, oldValue: string, newValue: string): Promise<PropertyDefinition>
  setOptionColor(name: string, value: string, color: string): Promise<PropertyDefinition>
  merge(
    entityId: string,
    values: Record<string, unknown>
  ): Promise<{ properties: Record<string, unknown>; removed: string[] }>
  resolveRefs(uris: string[]): Promise<ResolvedRelationRef[]>
  calendarNames(): Promise<string[]>
  setCalendarVisibility(name: string, show: boolean): Promise<{ success: true }>
}

const DEFAULT_OPTION_COLOR = 'stone'
const OPTION_TYPES: ReadonlySet<string> = new Set([
  PropertyTypes.SELECT,
  PropertyTypes.MULTISELECT,
  PropertyTypes.STATUS
])

function parseObject(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {}
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

// Select options are stored as `{value, color}` objects; a bare string, which
// an older `properties define --options '["a","b"]'` could write, reads as one.
function parseSelectOptions(value: string | null | undefined): SelectOption[] {
  if (!value) return []
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((entry): SelectOption[] => {
      if (typeof entry === 'string') return [{ value: entry, color: DEFAULT_OPTION_COLOR }]
      if (entry && typeof entry === 'object' && typeof (entry as SelectOption).value === 'string') {
        return [entry as SelectOption]
      }
      return []
    })
  } catch {
    return []
  }
}

/** `properties.md` entries by name; `{}` when the file is missing or unreadable. */
async function readFileEntries(
  vaultPath: string
): Promise<Record<string, Record<string, unknown>>> {
  try {
    const raw = await fs.readFile(path.join(getMemryDir(vaultPath), 'properties.md'), 'utf8')
    const properties = matter(raw).data.properties
    return properties && typeof properties === 'object' && !Array.isArray(properties)
      ? (properties as Record<string, Record<string, unknown>>)
      : {}
  } catch {
    return {}
  }
}

export function createPropertyToolsService({
  vaultPath,
  dataDb,
  notes,
  properties
}: {
  vaultPath: string
  dataDb: DataDb
  notes: NotesService
  properties: PropertiesService
}): PropertyToolsService {
  async function requireDefinition(name: string): Promise<PropertyDefinition> {
    const definition = (await properties.definitions()).find((item) => item.name === name)
    if (!definition) throw new Error(`No property definition named "${name}"`)
    if (!OPTION_TYPES.has(definition.type)) {
      throw new Error(`Property "${name}" is a ${definition.type} property and has no options`)
    }
    return definition
  }

  // Applies `edit` to every option of the definition — the flat list for
  // select/multiselect, each category's list for status — and saves it through
  // the definitions service, which also keeps `.memry/properties.md` current.
  async function editOptions(
    name: string,
    edit: (options: SelectOption[]) => SelectOption[]
  ): Promise<PropertyDefinition> {
    const definition = await requireDefinition(name)
    if (definition.type === PropertyTypes.STATUS) {
      const categories: StatusCategories = parseStatusCategories(definition.options)
      const next = { ...categories }
      for (const key of STATUS_CATEGORY_KEYS) {
        next[key] = { ...categories[key], options: edit(categories[key].options) }
      }
      return saved(name, JSON.stringify({ categories: next }))
    }
    return saved(name, JSON.stringify(edit(parseSelectOptions(definition.options))))
  }

  async function saved(name: string, options: string): Promise<PropertyDefinition> {
    const updated = await properties.updateDefinition(name, { options })
    if (!updated) throw new Error(`No property definition named "${name}"`)
    return updated
  }

  async function calendarEnabledNames(): Promise<string[]> {
    const names = new Set<string>()
    for (const definition of await properties.definitions()) {
      if (
        definition.type === PropertyTypes.DATE &&
        parseObject(definition.options).showOnCalendar === true
      ) {
        names.add(definition.name)
      }
    }
    for (const [name, entry] of Object.entries(await readFileEntries(vaultPath))) {
      if (entry?.type === 'date' && entry.showOnCalendar === true) names.add(name)
    }
    return [...names].sort()
  }

  return {
    async ensureDefinition(name, type) {
      const existing = (await properties.definitions()).find((item) => item.name === name)
      if (existing?.type === type) return existing
      // Adding a property names its type, so an existing name takes that type
      // and keeps its colour, like desktop's ensure-property-definition.
      return properties.createDefinition({
        name,
        type,
        options:
          type === PropertyTypes.STATUS
            ? JSON.stringify({ categories: DEFAULT_STATUS_CATEGORIES })
            : type === PropertyTypes.SELECT || type === PropertyTypes.MULTISELECT
              ? (existing?.options ?? '[]')
              : null,
        color: existing?.color ?? null
      })
    },

    async addOption(name, option, categoryKey) {
      const value = option.value.trim()
      if (!value) throw new Error('Option value is required')
      const entry: SelectOption = { value, color: option.color ?? DEFAULT_OPTION_COLOR }
      const existing = (await properties.definitions()).find((item) => item.name === name)

      if (categoryKey !== undefined || existing?.type === PropertyTypes.STATUS) {
        if (existing && existing.type !== PropertyTypes.STATUS) {
          throw new Error(`Property "${name}" is not a status property`)
        }
        const key = (categoryKey ?? 'todo') as StatusCategoryKey
        if (!STATUS_CATEGORY_KEYS.includes(key)) {
          throw new Error(
            `Unknown status category "${key}". Use ${STATUS_CATEGORY_KEYS.join(', ')}`
          )
        }
        // A status property with no stored categories shows the defaults, so
        // materialize what the picker shows instead of dropping the write.
        const categories = parseStatusCategories(existing?.options)
        const category = categories[key]
        if (!category.options.some((held) => held.value === value)) {
          const next = {
            ...categories,
            [key]: { ...category, options: [...category.options, entry] }
          }
          const options = JSON.stringify({ categories: next })
          return existing
            ? saved(name, options)
            : properties.createDefinition({ name, type: PropertyTypes.STATUS, options })
        }
        return existing as PropertyDefinition
      }

      if (!existing) {
        return properties.createDefinition({
          name,
          type: PropertyTypes.SELECT,
          options: JSON.stringify([entry])
        })
      }
      const definition = await requireDefinition(name)
      const options = parseSelectOptions(definition.options)
      if (options.some((held) => held.value === value)) return definition
      return saved(name, JSON.stringify([...options, entry]))
    },

    removeOption(name, value) {
      return editOptions(name, (options) => options.filter((option) => option.value !== value))
    },

    // Like desktop, this edits the definition only. Notes that already hold the
    // old value keep it until they are rewritten.
    renameOption(name, oldValue, newValue) {
      if (!newValue.trim()) throw new Error('New option value is required')
      return editOptions(name, (options) =>
        options.map((option) =>
          option.value === oldValue ? { ...option, value: newValue } : option
        )
      )
    },

    setOptionColor(name, value, color) {
      if (!color.trim()) throw new Error('Color is required')
      return editOptions(name, (options) =>
        options.map((option) => (option.value === value ? { ...option, color } : option))
      )
    },

    async merge(entityId, values) {
      const note = await notes.get(entityId)
      if (!note) throw new Error(`Entity not found: ${entityId}`)
      // A patch sets only the given keys; a null value removes its key.
      const next = { ...note.properties }
      for (const [key, value] of Object.entries(values)) {
        if (value === null) delete next[key]
        else next[key] = value
      }
      const updated = await notes.update({ id: note.id, properties: next })
      return {
        properties: updated.properties,
        removed: Object.keys(values).filter(
          (key) => values[key] === null && !Object.hasOwn(updated.properties, key)
        )
      }
    },

    // Same grouping as desktop's resolveRefs: one query per kind, results in
    // input order, and a malformed or missing target is `exists: false`, never
    // an error. Note and journal targets read `note_metadata` here because the
    // CLI keeps no note index of its own.
    async resolveRefs(uris) {
      const parsed = uris.map((uri) => parseRelationUri(uri))
      const idsByKind: Record<RelationKind, string[]> = {
        note: [],
        task: [],
        event: [],
        'external-event': [],
        canvas: [],
        journal: []
      }
      for (const ref of parsed) if (ref) idsByKind[ref.kind].push(ref.id)

      const noteRows = idsByKind.note.length
        ? dataDb.select().from(noteMetadata).where(inArray(noteMetadata.id, idsByKind.note)).all()
        : []
      const journalRows = idsByKind.journal.length
        ? dataDb
            .select()
            .from(noteMetadata)
            .where(inArray(noteMetadata.journalDate, idsByKind.journal))
            .all()
        : []
      const taskRows = idsByKind.task.length
        ? dataDb.select().from(tasks).where(inArray(tasks.id, idsByKind.task)).all()
        : []
      const eventRows = idsByKind.event.length
        ? dataDb
            .select()
            .from(calendarEvents)
            .where(inArray(calendarEvents.id, idsByKind.event))
            .all()
        : []
      const externalIds = idsByKind['external-event'].flatMap(
        (id) => decodeExternalEventRelationId(id) ?? []
      )
      const externalRows = externalIds.length
        ? dataDb
            .select()
            .from(calendarExternalEvents)
            .where(inArray(calendarExternalEvents.id, externalIds))
            .all()
        : []
      // A soft-deleted canvas is a dangling target.
      const canvasRows = idsByKind.canvas.length
        ? dataDb
            .select()
            .from(canvases)
            .where(and(inArray(canvases.id, idsByKind.canvas), isNull(canvases.deletedAt)))
            .all()
        : []

      const noteById = new Map(noteRows.map((row) => [row.id, row]))
      const taskById = new Map(taskRows.map((row) => [row.id, row]))
      const eventById = new Map(eventRows.map((row) => [row.id, row]))
      const canvasById = new Map(canvasRows.map((row) => [row.id, row]))
      const externalById = new Map(externalRows.map((row) => [row.id, row]))
      const journalByDate = new Map<string, (typeof journalRows)[number]>()
      for (const row of journalRows) {
        if (row.journalDate && !journalByDate.has(row.journalDate)) {
          journalByDate.set(row.journalDate, row)
        }
      }

      return uris.map((uri, index): ResolvedRelationRef => {
        const ref = parsed[index]
        if (!ref) return { uri, targetType: 'note', targetId: '', title: '', exists: false }
        const missing: ResolvedRelationRef = {
          uri,
          targetType: ref.kind,
          targetId: ref.id,
          title: '',
          exists: false
        }

        if (ref.kind === 'note') {
          const note = noteById.get(ref.id)
          if (!note) return missing
          return {
            ...missing,
            title: note.title,
            exists: true,
            ...(note.fileType !== 'markdown' ? { fileType: note.fileType } : {}),
            ...(note.emoji ? { emoji: note.emoji } : {})
          }
        }
        if (ref.kind === 'task') {
          const task = taskById.get(ref.id)
          if (!task) return missing
          return {
            ...missing,
            title: task.title,
            exists: true,
            ...(task.projectId ? { projectId: task.projectId } : {})
          }
        }
        if (ref.kind === 'canvas') {
          const canvas = canvasById.get(ref.id)
          return canvas ? { ...missing, title: canvas.title ?? '', exists: true } : missing
        }
        if (ref.kind === 'journal') {
          const journal = journalByDate.get(ref.id)
          return journal
            ? { ...missing, title: journal.title || ref.id, exists: true, date: ref.id }
            : missing
        }
        if (ref.kind === 'external-event') {
          const rowId = decodeExternalEventRelationId(ref.id)
          const row = rowId ? externalById.get(rowId) : undefined
          if (!row) return missing
          return {
            ...missing,
            title: row.title,
            exists: true,
            startAt: row.startAt,
            calendarItemId: row.id
          }
        }
        const event = eventById.get(ref.id)
        if (!event) return missing
        return {
          ...missing,
          title: event.title,
          exists: true,
          startAt: event.startAt,
          calendarItemId: ref.id
        }
      })
    },

    calendarNames: calendarEnabledNames,

    async setCalendarVisibility(name, show) {
      const existing = (await properties.definitions()).find((item) => item.name === name)
      const fileEntry = (await readFileEntries(vaultPath))[name]
      const isDate = existing ? existing.type === PropertyTypes.DATE : fileEntry?.type === 'date'
      const color = existing?.color ?? fileEntry?.color
      const defaultValue = existing?.defaultValue ?? fileEntry?.defaultValue

      if (show) {
        const options = JSON.stringify({
          ...(isDate ? parseObject(existing?.options) : {}),
          showOnCalendar: true
        })
        if (existing && isDate) await properties.updateDefinition(name, { options })
        else await properties.createDefinition({ name, type: PropertyTypes.DATE, options })
      } else if (isDate && !color && !defaultValue) {
        // A bare date definition exists only to carry the flag, so it goes with it.
        await properties.deleteDefinition(name)
      } else if (isDate) {
        const options = JSON.stringify({ ...parseObject(existing?.options), showOnCalendar: false })
        if (existing) await properties.updateDefinition(name, { options })
        else await properties.createDefinition({ name, type: PropertyTypes.DATE, options })
      }
      return { success: true }
    }
  }
}
