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
import { getMainI18n } from '../lib/main-i18n'
import { flushProjectionEvents } from '../projections'

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
    return { success: false, error: getMainI18n().t('errors:property.entityNotFound') }
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

const mergeQueues = new Map<string, Promise<unknown>>()

/**
 * Sets only the given keys on the entity's stored record and leaves the rest;
 * a null value removes its key. Merges on one entity run one after another,
 * each reading the record the previous one wrote, so two concurrent
 * single-key writes both survive.
 */
export function mergeEntityProperties(
  entityId: string,
  values: Record<string, unknown>
): Promise<SetEntityPropertiesResult> {
  const previous = mergeQueues.get(entityId) ?? Promise.resolve()
  const run = previous
    .catch(() => undefined)
    .then(async () => {
      // note_properties is written by the projection lane; wait for the
      // writes queued before this merge so it reads the latest record.
      await flushProjectionEvents()
      const record = getEntityPropertiesRecord(entityId)
      if (!record) {
        return { success: false, error: getMainI18n().t('errors:property.entityNotFound') } as const
      }
      for (const [name, value] of Object.entries(values)) {
        if (value === null) delete record[name]
        else record[name] = value
      }
      const result = await setEntityProperties(entityId, record)
      await flushProjectionEvents()
      return result
    })
  mergeQueues.set(entityId, run)
  void run.finally(() => {
    if (mergeQueues.get(entityId) === run) mergeQueues.delete(entityId)
  })
  return run
}

/** The entity's current properties as a plain record, or null if it does not exist. */
export function getEntityPropertiesRecord(entityId: string): Record<string, unknown> | null {
  const db = getIndexDatabase()
  if (!getNoteCacheById(db, entityId)) return null
  return getNotePropertiesAsRecord(db, entityId)
}
