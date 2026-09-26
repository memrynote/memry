import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { propertyDefinitions } from '@memry/db-schema/schema/notes-cache'
import { SyncQueueManager } from '@memry/sync-client/queue'
import { createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'
import type { DrizzleDb } from '@memry/sync-client/item-handlers/types'
import type { IndexDb } from '../database'

const state = vi.hoisted(() => ({ testDb: null as TestDatabaseResult | null }))

vi.mock('../database', () => ({
  getDatabase: () => state.testDb!.db
}))

vi.mock('@main/database/queries/notes', () => ({
  extractDateFromPath: vi.fn(() => null),
  getNoteCacheByPath: vi.fn(() => undefined)
}))

vi.mock('../projections', () => ({
  publishProjectionEvent: vi.fn()
}))

vi.mock('../lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

vi.mock('./property-definitions', () => ({
  PropertyDefinitionsService: { tryGet: () => null }
}))

import { syncNoteToCache } from './note-sync'
import { propertyDefinitionHandler } from '../sync/item-handlers/property-definition-handler'

const FIXED_ISO = '2026-01-15T12:00:00.000Z'

describe('syncNoteToCache property definitions', () => {
  beforeEach(() => {
    state.testDb = createTestDataDb()
  })

  afterEach(() => {
    state.testDb?.close()
    state.testDb = null
  })

  it('writes no definition for a relation property, so nothing can push one', () => {
    const testDb = state.testDb!
    syncNoteToCache(
      {} as IndexDb,
      {
        id: 'note-1',
        path: 'notes/linked.md',
        fileContent: '---\n---\n',
        parsedContent: '',
        frontmatter: { tags: [], related: ['memry://note/abc123'], area: 'Work' },
        title: 'linked',
        createdAt: FIXED_ISO,
        modifiedAt: FIXED_ISO
      },
      { isNew: true }
    )

    expect(
      testDb.db
        .select({ name: propertyDefinitions.name, type: propertyDefinitions.type })
        .from(propertyDefinitions)
        .all()
    ).toEqual([{ name: 'area', type: 'text' }])

    const queue = new SyncQueueManager(testDb.db as never)
    propertyDefinitionHandler.seedUnclocked(testDb.db as unknown as DrizzleDb, 'device-a', queue)
    expect(queue.peek(10).map(({ type, itemId }) => ({ type, itemId }))).toEqual([
      { type: 'property_definition', itemId: 'area' }
    ])
  })
})
