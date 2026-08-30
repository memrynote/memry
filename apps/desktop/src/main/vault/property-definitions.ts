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
  DEFAULT_STATUS_DEFINITION
} from '@memry/contracts/property-types'
import { propertyDefinitions as propertyDefinitionsTable } from '@memry/db-schema/schema/notes-cache'

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
      this.cache.clear()
      this.rebuildDbCache()
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
      this.rebuildDbCache()
    } catch (err) {
      logger.warn('Failed to parse properties.md, keeping last-known-good cache:', err)
    }
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
    })
  }

  async remove(name: string): Promise<void> {
    await this.enqueueWrite(async () => {
      this.cache.delete(name)
      await this.persistToFile()
      this.rebuildDbCache()
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

    // The picker shows DEFAULT_STATUS_DEFINITION's categories for a status
    // property that has none persisted, so materialize what the user is looking
    // at instead of dropping the write.
    const categories = def?.categories ?? DEFAULT_STATUS_DEFINITION.categories
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
          categories: def.categories ?? DEFAULT_STATUS_DEFINITION.categories
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
          color: null
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

  return { ...definition, categories: DEFAULT_STATUS_DEFINITION.categories }
}

export { DEFAULT_STATUS_DEFINITION }
