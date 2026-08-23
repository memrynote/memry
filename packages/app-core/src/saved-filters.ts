import { asc, eq } from 'drizzle-orm'
import { savedFilters } from '@memry/db-schema/data-schema'
import type { DrizzleDb as DataDb } from '@memry/db-schema/drizzle-db'
import { createId } from './ids.ts'

export interface SavedFilterRecord {
  id: string
  name: string
  config: unknown
  position: number
  createdAt: string
}

export interface CreateSavedFilterInput {
  name: string
  config: unknown
  position?: number
}

export interface UpdateSavedFilterInput {
  name?: string
  config?: unknown
  position?: number
}

export interface SavedFiltersService {
  list(): Promise<SavedFilterRecord[]>
  get(id: string): Promise<SavedFilterRecord | null>
  create(input: CreateSavedFilterInput): Promise<SavedFilterRecord>
  update(id: string, input: UpdateSavedFilterInput): Promise<SavedFilterRecord>
  reorder(ids: string[], positions: number[]): Promise<SavedFilterRecord[]>
  delete(id: string): Promise<boolean>
}

function nowIso(): string {
  return new Date().toISOString()
}

function toSavedFilter(row: typeof savedFilters.$inferSelect): SavedFilterRecord {
  return {
    id: row.id,
    name: row.name,
    config: row.config,
    position: row.position,
    createdAt: row.createdAt
  }
}

function nextPosition(db: DataDb): number {
  const rows = db.select().from(savedFilters).all()
  return rows.reduce((max, filter) => Math.max(max, filter.position), -1) + 1
}

export function createSavedFiltersService(dataDb: DataDb): SavedFiltersService {
  return {
    async list() {
      return dataDb
        .select()
        .from(savedFilters)
        .orderBy(asc(savedFilters.position))
        .all()
        .map(toSavedFilter)
    },

    async get(id) {
      const row = dataDb.select().from(savedFilters).where(eq(savedFilters.id, id)).get()
      return row ? toSavedFilter(row) : null
    },

    async create(input) {
      const name = input.name.trim()
      if (!name) throw new Error('Saved filter name is required')

      const id = createId('filter')
      dataDb
        .insert(savedFilters)
        .values({
          id,
          name,
          config: input.config,
          position: input.position ?? nextPosition(dataDb),
          createdAt: nowIso()
        })
        .run()

      const filter = await this.get(id)
      if (!filter) throw new Error('Saved filter not found after create')
      return filter
    },

    async update(id, input) {
      const row = dataDb
        .update(savedFilters)
        .set({
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.config !== undefined ? { config: input.config } : {}),
          ...(input.position !== undefined ? { position: input.position } : {})
        })
        .where(eq(savedFilters.id, id))
        .returning()
        .get()
      if (!row) throw new Error(`Saved filter not found: ${id}`)
      return toSavedFilter(row)
    },

    async reorder(ids, positions) {
      ids.forEach((id, index) => {
        dataDb
          .update(savedFilters)
          .set({ position: positions[index] ?? index })
          .where(eq(savedFilters.id, id))
          .run()
      })
      return this.list()
    },

    async delete(id) {
      dataDb.delete(savedFilters).where(eq(savedFilters.id, id)).run()
      return true
    }
  }
}
