import path from 'path'
import matter from 'gray-matter'
import { createLogger } from '../lib/logger'
import { atomicWrite, safeRead } from './file-ops'
import { getMemryDir } from './init'
import { getIndexDatabase, type DrizzleDb } from '../database'
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
    await this.enqueueWrite(async () => {
      this.cache.set(definition.name, definition)
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

  async renameOption(propertyName: string, oldValue: string, newValue: string): Promise<void> {
    const def = this.cache.get(propertyName)
    if (!def) return

    const updated = renameOptionInDefinition(def, oldValue, newValue)
    await this.upsert(updated)
  }

  async addOption(propertyName: string, option: SelectOption): Promise<void> {
    const def = this.cache.get(propertyName)
    if (!def) return

    const updated = addOptionToDefinition(def, option)
    await this.upsert(updated)
  }

  async removeOption(propertyName: string, optionValue: string): Promise<void> {
    const def = this.cache.get(propertyName)
    if (!def) return

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
    const def = this.cache.get(propertyName)
    if (!def) return

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
    if (!def || def.type !== 'status' || !def.categories) return

    const category = def.categories[categoryKey as keyof StatusCategories]
    if (!category) return

    const updated: PropertyDefinition = {
      ...def,
      categories: {
        ...def.categories,
        [categoryKey]: {
          ...category,
          options: [...category.options, option]
        }
      }
    }
    await this.upsert(updated)
  }

  private applyParsedData(data: PropertyDefinitionsFileData): void {
    this.cache.clear()
    for (const [name, def] of Object.entries(data.properties)) {
      if (def.type === 'status') {
        this.cache.set(name, { name, type: 'status', categories: def.categories })
      } else {
        this.cache.set(name, { name, type: def.type, options: def.options })
      }
    }
  }

  private async persistToFile(): Promise<void> {
    const properties: Record<string, unknown> = {}

    for (const [name, def] of this.cache) {
      if (def.type === 'status') {
        properties[name] = { type: 'status', categories: def.categories }
      } else {
        properties[name] = { type: def.type, options: def.options }
      }
    }

    const content = matter.stringify('', { properties })
    await atomicWrite(this.filePath, content)
    logger.debug('Persisted property definitions to', this.filePath)
  }

  private rebuildDbCache(): void {
    try {
      const db = getIndexDatabase() as DrizzleDb
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

      logger.debug('Rebuilt DB cache with', this.cache.size, 'definitions')
    } catch (err) {
      logger.warn('Failed to rebuild property definitions DB cache:', err)
    }
  }

  private async enqueueWrite(task: WriteTask): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.writeQueue.push(async () => {
        try {
          await task()
          resolve()
        } catch (err) {
          reject(err)
        }
      })
      this.drainQueue()
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
  return {
    ...def,
    options: [...(def.options ?? []), option]
  }
}

export { DEFAULT_STATUS_DEFINITION }
