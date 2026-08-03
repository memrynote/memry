/**
 * Templates schema guards.
 *
 * Lives in the desktop main suite because @memry/db-schema ships no test
 * runner of its own (typecheck only).
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { templates } from '@memry/db-schema/schema/templates'
import * as dataSchema from '@memry/db-schema/data-schema'
import * as schemaIndex from '@memry/db-schema/schema'
import { createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'

describe('templates schema', () => {
  it('is exported from both barrels', () => {
    // data-schema.ts drives drizzle-kit; schema/index.ts is what consumers
    // import. Missing from data-schema.ts => drizzle-kit emits a DROP TABLE.
    expect(dataSchema).toHaveProperty('templates')
    expect(schemaIndex).toHaveProperty('templates')
  })

  it('carries the columns record sync needs', () => {
    const columns = Object.keys(templates)
    for (const column of [
      'id',
      'name',
      'description',
      'icon',
      'tags',
      'properties',
      'content',
      'clock',
      'syncedAt',
      'createdAt',
      'modifiedAt'
    ]) {
      expect(columns).toContain(column)
    }
  })
})

describe('templates migration', () => {
  let testDb: TestDatabaseResult

  beforeEach(() => {
    testDb = createTestDataDb()
  })

  afterEach(() => {
    testDb.close()
  })

  it('creates the table with sync defaults applied', () => {
    testDb.db.insert(templates).values({ id: 'tpl-1', name: 'Standup' }).run()

    const row = testDb.db.select().from(templates).get()
    expect(row).toMatchObject({ id: 'tpl-1', name: 'Standup', content: '', tags: [] })
    // clock NULL is what seedUnclocked keys off to push pre-sync rows.
    expect(row?.clock).toBeNull()
    expect(row?.createdAt).toBeTruthy()
  })
})
