import { deletePropertyDefinition as deletePropertyDefinitionCache } from '@main/database/queries/notes'
import { deletePropertyDefinition as deleteCanonicalPropertyDefinition } from '@memry/storage-data'
import { getDatabase, getIndexDatabase } from '../database'
import {
  enqueuePropertyDefinitionDelete,
  readPropertyDefinitionRow
} from './property-definition-sync-effects'

export function deletePropertyDefinitionRecord(name: string): void {
  // Read before the delete: the tombstone carries the row's clock, and a
  // clockless one is skipped by every peer as older than what they hold.
  const snapshot = readPropertyDefinitionRow(name)
  deleteCanonicalPropertyDefinition(getDatabase(), name)
  deletePropertyDefinitionCache(getIndexDatabase(), name)
  enqueuePropertyDefinitionDelete(name, snapshot)
}
