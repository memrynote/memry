import path from 'path'
import matter from 'gray-matter'
import { createLogger } from '../lib/logger'
import { atomicWrite, safeRead } from './file-ops'
import { getMemryDir } from './init'
import { getDatabase, getIndexDatabase, type DataDb, type IndexDb } from '../database'
import {
  PropertyDefinitionsFileSchema,
  type PropertyDefinition,
  type PropertyDefinitionsFileData,
  type SelectOption,
  type StatusCategories,
  DEFAULT_STATUS_CATEGORIES,
  DEFAULT_STATUS_DEFINITION
} from '@memry/contracts/property-types'
import { propertyDefinitions as propertyDefinitionsTable } from '@memry/db-schema/schema/notes-cache'
import {
  enqueuePropertyDefinitionDelete,
  enqueuePropertyDefinitionUpsert,
  readPropertyDefinitionRow
} from './property-definition-sync-effects'
import { isNotNull } from 'drizzle-orm'

const logger = createLogger('PropertyDefinitions')

const PROPERTIES_FILE = 'properties.md'

type WriteTask = () => Promise<void>

let instance: PropertyDefinitionsService | null = null

export class PropertyDefinitionsService {
  private vaultPath: string
  private cache: Map<string, PropertyDefinition> = new Map()
  private writeQueue: WriteTask[] = []
  private writing = false

  constructor(vaultPath: string) {
    this.vaultPath = vaultPath
  }

  static init(vaultPath: string): PropertyDefinitionsService {
    instance = new PropertyDefinitionsService(vaultPath)
    return instance
  }

  static get(): PropertyDefinitionsService {
    if (!instance) throw new Error('PropertyDefinitionsService not initialized')
    return instance
  }

  static destroy(): void {
    instance = null
  }

  get filePath(): string {
    return path.join(getMemryDir(this.vaultPath), PROPERTIES_FILE)
  }

  async reload(): Promise<void> {
    const raw = await safeRead(this.filePath)
    if (!raw) {
      // No file yet is the normal state of a device that has just been linked,
      // and its first pull can land definitions before anything writes one.
      // Clearing the cache without the union would delete them again.
      this.cache.clear()
      const gained = this.mergeSyncedDefinitions()
      this.rebuildDbCache()
      if (gained) await this.persistToFile()
      return
    }

    try {
      const { data } = matter(raw)
      const parsed = PropertyDefinitionsFileSchema.safeParse(data)

      if (!parsed.success) {
        logger.warn('Invalid properties.md format, keeping last-known-good cache:', parsed.error)
        return
      }

      this.applyParsedData(parsed.data)
      const gained = this.mergeSyncedDefinitions()
      this.rebuildDbCache()
      // A definition that arrived over sync exists only as a data DB row until
      // this write. `applyParsedData` above clears the cache from the file, so
      // without the union plus this persist the very next pull would rebuild
      // the DB from the file alone and delete the row that just landed.
      if (gained) await this.persistToFile()
    } catch (err) {
      logger.warn('Failed to parse properties.md, keeping last-known-good cache:', err)
    }
  }

  /**
   * Fold the clocked data DB rows into the cache, and report whether the file
   * is now out of date.
   *
   * Union only. The file wins for any name it already covers — it is what a
   * human edits, and the pull path has already resolved that name's clock.
   */
  private mergeSyncedDefinitions(): boolean {
    let gained = false
    try {
      const rows = getDatabase()
        .select()
        .from(propertyDefinitionsTable)
        .where(isNotNull(propertyDefinitionsTable.clock))
        .all()
      for (const row of rows) {
        if (this.cache.has(row.name)) continue
        const definition = definitionFromRow(row)
        if (!definition) continue
        this.cache.set(row.name, definition)
        gained = true
      }
    } catch (err) {
      logger.warn('Failed to merge synced property definitions:', err)
    }
    return gained
  }

  /**
   * Drop a definition a peer deleted.
   *
   * The handler has already removed the DB row, so the union above will not
   * bring it back — but `.memry/properties.md` still names it, and the next
   * reload would read it straight back in.
   */
  async applyRemoteDelete(name: string): Promise<void> {
    if (!this.cache.has(name)) return
    await this.enqueueWrite(async () => {
      this.cache.delete(name)
      await this.persistToFile()
    })
  }

  getAll(): PropertyDefinition[] {
    return Array.from(this.cache.values())
  }

  get(name: string): PropertyDefinition | undefined {
    return this.cache.get(name)
  }

  async upsert(definition: PropertyDefinition): Promise<void> {
    const normalized = normalizeDefinition(definition)
    await this.enqueueWrite(async () => {
      this.cache.set(normalized.name, normalized)
      await this.persistToFile()
      this.rebuildDbCache()
      enqueuePropertyDefinitionUpsert(normalized.name)
    })
  }

  async remove(name: string): Promise<void> {
    const snapshot = readPropertyDefinitionRow(name)
    await this.enqueueWrite(async () => {
      this.cache.delete(name)
      await this.persistToFile()
      this.rebuildDbCache()
      // The row is gone by now, so the tombstone has to carry the copy taken
      // before the rebuild — a delete with no payload has no clock, and peers
      // treat a clockless tombstone as older than what they hold and skip it.
      enqueuePropertyDefinitionDelete(name, snapshot)
    })
  }

  async setShowOnCalendar(name: string, show: boolean): Promise<void> {
    await this.enqueueWrite(async () => {
      const existing = this.cache.get(name)
      if (show) {
        this.cache.set(name, { name, type: 'date', showOnCalendar: true })
      } else if (existing?.type === 'date') {
        // date entries only carry the calendar flag → drop the entry when off
        this.cache.delete(name)
      } else if (existing) {
        this.cache.set(name, { ...existing, showOnCalendar: false })
      }
      await this.persistToFile()
      this.rebuildDbCache()
      if (this.cache.has(name)) enqueuePropertyDefinitionUpsert(name)
      else enqueuePropertyDefinitionDelete(name, null)
    })
  }

  listCalendarEnabledNames(): string[] {
    return Array.from(this.cache.values())
      .filter((def) => def.showOnCalendar === true)
      .map((def) => def.name)
  }

  async renameOption(propertyName: string, oldValue: string, newValue: string): Promise<void> {
    const def = this.requireDefinition(propertyName)

    const updated = renameOptionInDefinition(def, oldValue, newValue)
    await this.upsert(updated)
  }

  async addOption(propertyName: string, option: SelectOption): Promise<void> {
    const def = this.requireDefinition(propertyName)

    const updated = addOptionToDefinition(def, option)
    await this.upsert(updated)
  }

  async removeOption(propertyName: string, optionValue: string): Promise<void> {
    const def = this.requireDefinition(propertyName)

    if (def.type === 'status' && def.categories) {
      const categories = { ...def.categories }
      for (const key of Object.keys(categories) as (keyof StatusCategories)[]) {
        categories[key] = {
          ...categories[key],
          options: categories[key].options.filter((o) => o.value !== optionValue)
        }
      }
      await this.upsert({ ...def, categories })
    } else {
      await this.upsert({
        ...def,
        options: def.options?.filter((o) => o.value !== optionValue)
      })
    }
  }

  async updateOptionColor(
    propertyName: string,
    optionValue: string,
    newColor: string
  ): Promise<void> {
    const def = this.requireDefinition(propertyName)

    const updateColor = (o: SelectOption) =>
      o.value === optionValue ? { ...o, color: newColor } : o

    if (def.type === 'status' && def.categories) {
      const categories = { ...def.categories }
      for (const key of Object.keys(categories) as (keyof StatusCategories)[]) {
        categories[key] = {
          ...categories[key],
          options: categories[key].options.map(updateColor)
        }
      }
      await this.upsert({ ...def, categories })
    } else {
      await this.upsert({
        ...def,
        options: def.options?.map(updateColor)
      })
    }
  }

  async addStatusOption(
    propertyName: string,
    categoryKey: string,
    option: SelectOption
  ): Promise<void> {
    const def = this.cache.get(propertyName)
    if (def && def.type !== 'status') {
      throw new Error(`Property "${propertyName}" is not a status property`)
    }

    // The picker shows the default categories for a status property that has
    // none persisted, so materialize what the user is looking at instead of
    // dropping the write.
    const categories = def?.categories ?? DEFAULT_STATUS_CATEGORIES
    const category = categories[categoryKey as keyof StatusCategories]
    if (!category) {
      throw new Error(`Unknown status category "${categoryKey}"`)
    }

    if (category.options.some((o) => o.value === option.value)) {
      logger.debug('Status option already exists, skipping', propertyName, option.value)
      return
    }

    const updated: PropertyDefinition = {
      name: propertyName,
      type: 'status',
      ...def,
      categories: {
        ...categories,
        [categoryKey]: {
          ...category,
          options: [...category.options, option]
        }
      }
    }
    await this.upsert(updated)
  }

  private requireDefinition(propertyName: string): PropertyDefinition {
    const def = this.cache.get(propertyName)
    if (!def) {
      throw new Error(`No property definition named "${propertyName}"`)
    }
    return def
  }

  private applyParsedData(data: PropertyDefinitionsFileData): void {
    this.cache.clear()
    for (const [name, def] of Object.entries(data.properties)) {
      if (def.type === 'status') {
        this.cache.set(name, { name, type: 'status', categories: def.categories })
      } else if (def.type === 'date') {
        this.cache.set(name, { name, type: 'date', showOnCalendar: def.showOnCalendar })
      } else if (def.type === 'project') {
        this.cache.set(name, { name, type: 'project' })
      } else {
        this.cache.set(name, { name, type: def.type, options: def.options })
      }
    }
  }

  private async persistToFile(): Promise<void> {
    const properties: Record<string, unknown> = {}

    for (const [name, def] of this.cache) {
      // js-yaml refuses to dump `undefined`, and one such value fails the write
      // for every property in the file, not just its own.
      if (def.type === 'status') {
        properties[name] = {
          type: 'status',
          categories: def.categories ?? DEFAULT_STATUS_CATEGORIES
        }
      } else if (def.type === 'date') {
        properties[name] = { type: 'date', showOnCalendar: def.showOnCalendar ?? false }
      } else if (def.type === 'project') {
        properties[name] = { type: 'project' }
      } else {
        properties[name] = { type: def.type, options: def.options ?? [] }
      }
    }

    const content = matter.stringify('', { properties })
    await atomicWrite(this.filePath, content)
    logger.debug('Persisted property definitions to', this.filePath)
  }

  private rebuildDbCache(): void {
    try {
      this.rebuildSingleDbCache(getDatabase())
      this.rebuildSingleDbCache(getIndexDatabase())
      logger.debug('Rebuilt DB cache with', this.cache.size, 'definitions')
    } catch (err) {
      logger.warn('Failed to rebuild property definitions DB cache:', err)
    }
  }

  private rebuildSingleDbCache(db: DataDb | IndexDb): void {
    // The data DB's copy of this table is a SYNCED row, so its clock has to
    // survive a rebuild the file triggers. Losing it makes every definition
    // look unclocked, and `seedUnclocked` then re-pushes the whole set as
    // creates on the next sync.
    const carried = new Map(
      db
        .select()
        .from(propertyDefinitionsTable)
        .all()
        .map((row) => [row.name, { clock: row.clock, syncedAt: row.syncedAt }])
    )

    db.delete(propertyDefinitionsTable).run()

    for (const def of this.cache.values()) {
      const options =
        def.type === 'status' && def.categories
          ? JSON.stringify({ categories: def.categories })
          : def.options
            ? JSON.stringify(def.options)
            : null

      db.insert(propertyDefinitionsTable)
        .values({
          name: def.name,
          type: def.type,
          options,
          defaultValue: def.defaultValue ?? null,
          color: null,
          clock: carried.get(def.name)?.clock ?? null,
          syncedAt: carried.get(def.name)?.syncedAt ?? null
        })
        .run()
    }
  }

  private async enqueueWrite(task: WriteTask): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.writeQueue.push(async () => {
        try {
          await task()
          resolve()
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)))
        }
      })
      void this.drainQueue()
    })
  }

  private async drainQueue(): Promise<void> {
    if (this.writing) return
    this.writing = true

    while (this.writeQueue.length > 0) {
      const task = this.writeQueue.shift()!
      await task()
    }

    this.writing = false
  }
}

/**
 * A synced row, back as a definition.
 *
 * The inverse of what `rebuildSingleDbCache` writes: `status` keeps its
 * categories under an `options` wrapper, everything else stores a bare option
 * array. A row whose JSON no longer parses is dropped rather than allowed to
 * fail the whole reload — one bad definition must not cost the vault the rest.
 */
function definitionFromRow(row: {
  name: string
  type: string
  options: string | null
  defaultValue: string | null
}): PropertyDefinition | null {
  const type = row.type as PropertyDefinition['type']
  let parsed: unknown = null
  if (row.options) {
    try {
      parsed = JSON.parse(row.options)
    } catch {
      logger.warn('Synced property definition has unparseable options; ignoring them', row.name)
    }
  }

  if (type === 'status') {
    const categories = (parsed as { categories?: StatusCategories } | null)?.categories
    return { name: row.name, type, categories: categories ?? DEFAULT_STATUS_CATEGORIES }
  }
  if (type === 'date') return { name: row.name, type, showOnCalendar: false }
  if (type === 'project') return { name: row.name, type }

  return {
    name: row.name,
    type,
    options: Array.isArray(parsed) ? (parsed as SelectOption[]) : [],
    ...(row.defaultValue ? { defaultValue: row.defaultValue } : {})
  }
}

function renameOptionInDefinition(
  def: PropertyDefinition,
  oldValue: string,
  newValue: string
): PropertyDefinition {
  if (def.type === 'status' && def.categories) {
    const categories = { ...def.categories }
    for (const key of Object.keys(categories) as (keyof StatusCategories)[]) {
      categories[key] = {
        ...categories[key],
        options: categories[key].options.map((o) =>
          o.value === oldValue ? { ...o, value: newValue } : o
        )
      }
    }
    return { ...def, categories }
  }

  return {
    ...def,
    options: def.options?.map((o) => (o.value === oldValue ? { ...o, value: newValue } : o))
  }
}

function addOptionToDefinition(def: PropertyDefinition, option: SelectOption): PropertyDefinition {
  const options = def.options ?? []
  if (options.some((o) => o.value === option.value)) return def

  return {
    ...def,
    options: [...options, option]
  }
}

/**
 * A `status` definition with no categories cannot be serialized, so a write
 * carrying one threw and left the cache holding a definition that every later
 * status write skipped. The cache never holds one.
 */
function normalizeDefinition(definition: PropertyDefinition): PropertyDefinition {
  if (definition.type !== 'status' || definition.categories) return definition

  return { ...definition, categories: DEFAULT_STATUS_CATEGORIES }
}

export { DEFAULT_STATUS_DEFINITION }
