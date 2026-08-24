/**
 * One-time flip of `openPagesInNewTab` to off.
 *
 * The setting shipped defaulting to `true`, so clicking note after note in the
 * sidebar spawned a tab per click — the single loudest complaint in the 18–20
 * Aug feedback round. The default is now `false`, but flipping the constant
 * alone reaches nobody who already runs the app: `writePreferences` persists
 * the *whole* preferences object, so any user who ever changed the theme also
 * wrote `openPagesInNewTab: true` into `config.json` without ever making a
 * decision about tabs, and the stored value beats the default.
 *
 * This pass runs once per vault and rewrites that collateral `true`. It is not
 * a re-disable loop: the marker row is written on the first run whatever the
 * outcome, so a user who turns the preference back on afterwards keeps it on.
 *
 * Two deliberate restraints:
 *
 * - It skips the flip when settings sync holds a field clock for
 *   `general.openPagesInNewTab`. A clock only exists once *something* wrote the
 *   field through the sync seam — a local toggle in Settings, or a merge of
 *   another device's toggle — so its presence is a real record of an explicit
 *   choice. Its absence is not proof of the opposite (an install that never
 *   signed in has no clocks at all), which is why the flip is the default.
 * - It writes through `writePreferences` only, never through
 *   `syncSettingsFieldUpdate`. The flip therefore mints no clock of its own and
 *   can never out-rank another device's genuine `true` on the next merge; if a
 *   peer does hold an explicit `true`, its clock wins the round trip and this
 *   device is corrected back.
 *
 * Deleting this module (and its call in `vault/index.ts`) is the clean-up once
 * the flip is well past.
 *
 * @module settings/flip-open-pages-in-new-tab
 */

import type { DataDb } from '../database/types'
import { getSetting, setSetting } from '../database/queries/settings'
import { SETTINGS_SYNC_CLOCKS_KEY } from '@memry/sync-client/settings-sync-keys'
import { readPreferences, writePreferences } from '../vault/vault-preferences'
import { writeCacheFromPreferences } from '../vault/settings-cache'
import { createLogger } from '../lib/logger'

const logger = createLogger('Settings:TabReuseFlip')

const OPEN_PAGES_IN_NEW_TAB_FIELD = 'general.openPagesInNewTab'

/** Set once the vault has been through the flip, whatever the outcome. */
export const OPEN_PAGES_IN_NEW_TAB_FLIPPED_KEY = 'general.openPagesInNewTabDefaultFlipped'

export function flipOpenPagesInNewTabDefault(db: DataDb, vaultPath: string): void {
  if (getSetting(db, OPEN_PAGES_IN_NEW_TAB_FLIPPED_KEY)) return

  try {
    if (readPreferences(vaultPath).openPagesInNewTab && !hasSyncedChoice(db)) {
      writePreferences(vaultPath, { openPagesInNewTab: false })
      writeCacheFromPreferences(db, readPreferences(vaultPath))
      logger.info('Flipped openPagesInNewTab to off for this vault')
    }
  } catch (error) {
    // An unreadable or unwritable config.json is not worth failing vault open
    // over, and the marker below stops it retrying on every launch.
    logger.warn('Skipping openPagesInNewTab flip for this vault:', error)
  }

  setSetting(db, OPEN_PAGES_IN_NEW_TAB_FLIPPED_KEY, '1')
}

/**
 * Whether settings sync has ever recorded a write to the field — see the module
 * comment for why that counts as an explicit choice and its absence does not
 * count as the reverse.
 */
function hasSyncedChoice(db: DataDb): boolean {
  const raw = getSetting(db, SETTINGS_SYNC_CLOCKS_KEY)
  if (!raw) return false

  try {
    const clocks = JSON.parse(raw) as Record<string, unknown>
    return OPEN_PAGES_IN_NEW_TAB_FIELD in clocks
  } catch {
    // A corrupt clock blob tells us nothing; treat it as no recorded choice.
    return false
  }
}
