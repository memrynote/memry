/**
 * Task settings for non-IPC main callers (the import pipeline's checklist step).
 *
 * Same shape as `settings/features.ts`, and for the same two reasons: reading
 * the group through `ipc/settings-handlers.ts` would drag that module's whole
 * dependency tree (electron `app`, the embedding model, the vault store) into
 * every importer, and a read must never mutate the user's settings — the IPC
 * reader deletes a corrupt blob, which is right for a settings screen and wrong
 * for a background lookup.
 *
 * @module settings/task-settings
 */

import { TASK_SETTINGS_DEFAULTS, type TaskSettings } from '@memry/contracts/settings-schemas'
import { getDatabase } from '../database'
import { getSetting } from '../database/queries/settings'

const SETTINGS_GROUP_KEY = 'tasks'

export function getTaskSettings(): TaskSettings {
  let db: ReturnType<typeof getDatabase>
  try {
    db = getDatabase()
  } catch {
    // No vault open — every field reports its default.
    return { ...TASK_SETTINGS_DEFAULTS }
  }

  const raw = getSetting(db, SETTINGS_GROUP_KEY)
  if (!raw) return { ...TASK_SETTINGS_DEFAULTS }

  try {
    return { ...TASK_SETTINGS_DEFAULTS, ...(JSON.parse(raw) as Partial<TaskSettings>) }
  } catch {
    return { ...TASK_SETTINGS_DEFAULTS }
  }
}
