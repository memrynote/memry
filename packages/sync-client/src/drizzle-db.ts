/**
 * Re-export of the driver-agnostic database types. The canonical definition
 * lives in `@memry/db-schema` (next to the schemas it binds); this subpath
 * exists so sync-engine code keeps a sync-client-local import while files
 * migrate out of the desktop tree.
 */
export type { DrizzleDb, IndexDrizzleDb, SyncRunResult } from '@memry/db-schema/drizzle-db'
