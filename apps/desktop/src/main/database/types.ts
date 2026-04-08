import Database from 'better-sqlite3'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type * as dataSchema from '@memry/db-schema/data-schema'
import type * as indexSchema from '@memry/db-schema/index-schema'
import type * as legacySchema from '@memry/db-schema/schema'

export type DataDb = BetterSQLite3Database<typeof dataSchema>
export type IndexDb = BetterSQLite3Database<typeof indexSchema>
export type RawIndexDb = Database.Database

// Transitional compatibility alias for untouched legacy call sites.
export type DrizzleDb = BetterSQLite3Database<typeof legacySchema>
