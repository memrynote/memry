/**
 * Editor settings for non-IPC main callers (agent note writes). Same shape as
 * `task-settings.ts`, for the same reasons: no dependency on the IPC handler
 * module, and a read never deletes a corrupt blob.
 *
 * @module settings/editor-settings
 */

import { EDITOR_SETTINGS_DEFAULTS, type EditorSettings } from '@memry/contracts/settings-schemas'
import { getDatabase } from '../database'
import { getSetting } from '../database/queries/settings'

const SETTINGS_GROUP_KEY = 'editor'

export function getEditorSettings(): EditorSettings {
  let db: ReturnType<typeof getDatabase>
  try {
    db = getDatabase()
  } catch {
    return { ...EDITOR_SETTINGS_DEFAULTS }
  }

  const raw = getSetting(db, SETTINGS_GROUP_KEY)
  if (!raw) return { ...EDITOR_SETTINGS_DEFAULTS }

  try {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- JSON.parse/json() returns any; this is the stored editor settings JSON, spread over defaults so missing keys fall back
    return { ...EDITOR_SETTINGS_DEFAULTS, ...(JSON.parse(raw) as Partial<EditorSettings>) }
  } catch {
    return { ...EDITOR_SETTINGS_DEFAULTS }
  }
}
