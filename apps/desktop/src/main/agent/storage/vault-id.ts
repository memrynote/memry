import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'

import * as schema from '@memry/db-schema/data-schema'

const SINGLETON_ID = 'singleton'

export function getOrCreateVaultUuid(db: BetterSQLite3Database<typeof schema>): string {
  const existing = db
    .select()
    .from(schema.vaultMetadata)
    .where(eq(schema.vaultMetadata.id, SINGLETON_ID))
    .get()

  if (existing) return existing.vaultUuid

  const uuid = randomUUID()
  const now = Date.now()
  db.insert(schema.vaultMetadata)
    .values({ id: SINGLETON_ID, vaultUuid: uuid, createdAt: now, updatedAt: now })
    .run()
  return uuid
}
