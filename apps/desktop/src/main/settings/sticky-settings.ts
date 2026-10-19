/**
 * Sticky settings for main callers outside the settings screen: the send path
 * remembers the kind it used, the window code reads the tuck edge.
 *
 * Reads never mutate, for the reason given in `settings/task-settings.ts`.
 *
 * @module settings/sticky-settings
 */

import { STICKY_SETTINGS_DEFAULTS, type StickySettings } from '@memry/contracts/settings-schemas'
import { SettingsChannels } from '@memry/contracts/ipc-channels'
import type { StickyKind } from '@memry/contracts/sticky-api'
import { getDatabase } from '../database'
// Not settings-store: it reaches the query through the `@main/*` alias, which
// the vitest resolver lacks (see settings/features.ts). This group does not
// sync, so its write listener has nothing to do here.
import { getSetting, setSetting } from '../database/queries/settings'
import { broadcastToAllWindows } from '../lib/window-broadcast'
import { createLogger } from '../lib/logger'

const log = createLogger('StickySettings')

export const STICKY_SETTINGS_GROUP_KEY = 'sticky'

function tryGetDatabase(): ReturnType<typeof getDatabase> | null {
  try {
    return getDatabase()
  } catch {
    return null
  }
}

export function getStickySettings(): StickySettings {
  const db = tryGetDatabase()
  const raw = db ? getSetting(db, STICKY_SETTINGS_GROUP_KEY) : null
  if (!raw) return { ...STICKY_SETTINGS_DEFAULTS }

  try {
    return { ...STICKY_SETTINGS_DEFAULTS, ...(JSON.parse(raw) as Partial<StickySettings>) }
  } catch (err) {
    log.warn('Unreadable sticky settings, using defaults', err)
    return { ...STICKY_SETTINGS_DEFAULTS }
  }
}

/** The kind a fresh sticky starts on. */
export function getStartingStickyKind(): StickyKind {
  const settings = getStickySettings()
  return settings.defaultKind === 'last' ? settings.lastKind : settings.defaultKind
}

/** Remember the kind a send used, for `defaultKind: 'last'`. */
export function rememberStickyKind(kind: StickyKind): void {
  const db = tryGetDatabase()
  if (!db) return
  const current = getStickySettings()
  if (current.lastKind === kind) return

  setSetting(db, STICKY_SETTINGS_GROUP_KEY, JSON.stringify({ ...current, lastKind: kind }))
  broadcastToAllWindows(SettingsChannels.events.CHANGED, {
    key: STICKY_SETTINGS_GROUP_KEY,
    value: { lastKind: kind }
  })
}
