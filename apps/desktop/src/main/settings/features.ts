/**
 * Feature flags for non-IPC main callers (agent MCP canvas tools).
 *
 * Deliberately does NOT go through ipc/settings-handlers.ts or
 * settings/settings-store.ts: both reach the settings query via the `@main/*`
 * path alias, which is declared in tsconfig.node.json but not in the vitest
 * resolver — so importing either one makes the importing module unloadable
 * from a unit test. The relative import below keeps this readable everywhere.
 *
 * Read-only by design: unlike ipc/settings-handlers.ts `readGroupSettings`,
 * a corrupt blob here returns defaults WITHOUT deleting the stored key. A flag
 * lookup on a tool call must never mutate the user's settings as a side effect.
 *
 * @module settings/features
 */

import {
  FEATURES_SETTINGS_DEFAULTS,
  type FeaturesSettings
} from '@memry/contracts/settings-schemas'
import { getDatabase } from '../database'
import { getSetting } from '../database/queries/settings'

const SETTINGS_GROUP_KEY = 'features'

export function getFeaturesSettings(): FeaturesSettings {
  let db: ReturnType<typeof getDatabase>
  try {
    db = getDatabase()
  } catch {
    // No vault open — every feature reports its default.
    return { ...FEATURES_SETTINGS_DEFAULTS }
  }

  const raw = getSetting(db, SETTINGS_GROUP_KEY)
  if (!raw) return { ...FEATURES_SETTINGS_DEFAULTS }

  try {
    return { ...FEATURES_SETTINGS_DEFAULTS, ...(JSON.parse(raw) as Partial<FeaturesSettings>) }
  } catch {
    return { ...FEATURES_SETTINGS_DEFAULTS }
  }
}
