/**
 * Property write funnel for notes and journal entries.
 *
 * Notes and journal entries store user properties in frontmatter but are
 * written through different vault writers. This module is the single place
 * that decides which writer an entity id routes to.
 *
 * @module notes/entity-properties
 */

import { getNotePropertiesAsRecord } from '@main/database/queries/notes'
import { createLogger } from '../lib/logger'
import { getIndexDatabase } from '../database'
import { getNoteCacheById } from './store'
import { updateNote } from '../vault/notes'
import { syncNoteUpdate } from './runtime-effects'
import { enqueueJournalUpdate } from '../journal/runtime-effects'
import { updateJournalProperties } from '../journal/properties'

const logger = createLogger('EntityProperties')

export type SetEntityPropertiesResult = { success: true } | { success: false; error: string }

/**
 * Write a full property record onto a note or a journal entry, whichever the id
 * resolves to. The only funnel for property writes — the properties IPC handler,
 * the project-link reroute and project rename/delete propagation all go through it.
 */
export async function setEntityProperties(
  entityId: string,
  properties: Record<string, unknown>
): Promise<SetEntityPropertiesResult> {
  const db = getIndexDatabase()
  const entity = getNoteCacheById(db, entityId)

  if (!entity) {
    return { success: false, error: 'Entity not found' }
  }

  logger.debug('setEntityProperties', { entityId, propertyKeys: Object.keys(properties) })

  if (entity.date) {
    await updateJournalProperties(entity.date, properties)
    enqueueJournalUpdate(entityId, entity.date)
  } else {
    await updateNote({ id: entityId, properties })
    syncNoteUpdate(entityId)
  }

  return { success: true }
}

/** The entity's current properties as a plain record, or null if it does not exist. */
export function getEntityPropertiesRecord(entityId: string): Record<string, unknown> | null {
  const db = getIndexDatabase()
  if (!getNoteCacheById(db, entityId)) return null
  return getNotePropertiesAsRecord(db, entityId)
}
