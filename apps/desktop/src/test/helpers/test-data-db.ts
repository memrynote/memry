import { createTestDataDb as createRawTestDataDb } from '@tests/utils/test-db'
import type { DataDb } from '../../main/database/types'

export type TestDataDb = DataDb

/**
 * In-memory data-db handle for query tests, migrated against the real
 * drizzle-data migration files (via the shared factory in
 * `apps/desktop/tests/utils/test-db.ts` — reused here rather than
 * standing up a second migration runner).
 */
export function createTestDataDb(): TestDataDb {
  return createRawTestDataDb().db as unknown as TestDataDb
}
