import { beforeEach, describe, expect, it, vi } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { tagDefinitions } from '@memry/db-schema/schema/tag-definitions'
import type { ViewConfig } from '@memry/contracts/folder-view-api'
import { createTestDataDb, type TestDataDb } from '../../../test/helpers/test-data-db'

const { loggerWarnMock } = vi.hoisted(() => ({
  loggerWarnMock: vi.fn()
}))

vi.mock('../../lib/logger', () => ({
  createLogger: () => ({
    warn: loggerWarnMock
  })
}))

import { readTagViews, writeTagViews } from './tag-definitions'

let db: TestDataDb

beforeEach(() => {
  db = createTestDataDb()
})

function upsertTagDefinition(
  dataDb: TestDataDb,
  { name, color }: { name: string; color: string }
): void {
  const existing = dataDb.select().from(tagDefinitions).where(eq(tagDefinitions.name, name)).get()

  if (existing) {
    dataDb.update(tagDefinitions).set({ color }).where(eq(tagDefinitions.name, name)).run()
  } else {
    dataDb.insert(tagDefinitions).values({ name, color }).run()
  }
}

describe('tag views', () => {
  it('returns null for a tag that has never saved a view', () => {
    upsertTagDefinition(db, { name: 'araba', color: 'red' })
    expect(readTagViews(db, 'araba')).toBeNull()
  })

  it('round-trips a saved view', () => {
    upsertTagDefinition(db, { name: 'araba', color: 'red' })
    const views: ViewConfig[] = [
      { name: 'Open tasks', type: 'table', default: true, columns: [{ id: 'title', width: 250 }] }
    ]
    writeTagViews(db, 'araba', views)
    expect(readTagViews(db, 'araba')).toEqual(views)
  })

  it('matches the tag case-insensitively, like every other tag lookup', () => {
    upsertTagDefinition(db, { name: 'Araba', color: 'red' })
    writeTagViews(db, 'araba', [{ name: 'A', type: 'table' }])
    expect(readTagViews(db, 'ARABA')).toEqual([{ name: 'A', type: 'table' }])
  })

  it('clears saved views when given null', () => {
    upsertTagDefinition(db, { name: 'araba', color: 'red' })
    writeTagViews(db, 'araba', [{ name: 'A', type: 'table' }])
    writeTagViews(db, 'araba', null)
    expect(readTagViews(db, 'araba')).toBeNull()
  })

  it('returns null rather than throwing on corrupt JSON', () => {
    upsertTagDefinition(db, { name: 'araba', color: 'red' })
    db.run(sql`UPDATE tag_definitions SET views = '{not json' WHERE name = 'araba'`)
    expect(readTagViews(db, 'araba')).toBeNull()
  })
})
