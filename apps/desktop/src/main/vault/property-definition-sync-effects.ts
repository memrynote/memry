import { eq } from 'drizzle-orm'
import { propertyDefinitions } from '@memry/db-schema/schema/notes-cache'
import { enqueueLocalSyncDelete, enqueueLocalSyncUpdate } from '../sync/local-mutations'
import { getDatabase } from '../database'

/**
 * The push side of property definition sync, kept out of the service so the
 * vault module does not reach into sync itself. Mirrors
 * `settings/saved-filters-sync.ts`.
 */

/**
 * One entry point for create AND update.
 *
 * The distinction is not observable here: `rebuildDbCache` deletes and
 * reinserts the whole table on every write, so a definition the user is
 * "creating" and one they are editing look identical by the time this runs. The
 * record controller resolves it against the server's own state anyway.
 */
export function enqueuePropertyDefinitionUpsert(name: string): void {
  enqueueLocalSyncUpdate('property_definition', name)
}

export function enqueuePropertyDefinitionDelete(
  name: string,
  snapshotPayload: string | null
): void {
  enqueueLocalSyncDelete('property_definition', name, snapshotPayload ?? undefined)
}

/** The row as it stands, for a tombstone that has to outlive it. */
export function readPropertyDefinitionRow(name: string): string | null {
  try {
    const row = getDatabase()
      .select()
      .from(propertyDefinitions)
      .where(eq(propertyDefinitions.name, name))
      .get()
    return row ? JSON.stringify(row) : null
  } catch {
    return null
  }
}
