/**
 * One-time promotion of the spatialCanvas flag to on.
 *
 * `spatialCanvas` defaulted to `false` until the M7 rollout. Flipping the
 * default alone does not reach every install: `writeGroupSettings` persists the
 * whole `features` group, so a user who toggled *any* feature — Journal, Graph,
 * anything — also wrote `spatialCanvas: false` to disk without ever making a
 * decision about canvas. The stored value wins over the default, so those
 * installs would silently miss the surface the release is announcing.
 *
 * This pass runs once per vault and rewrites only that collateral `false`. It
 * is not a re-enable loop: the marker key is set on the first run whatever the
 * outcome, so a user who turns canvas off *after* the promotion keeps it off
 * forever. Deleting this module (and its call in `vault/index.ts`) is the
 * clean-up once the flip is well past.
 *
 * Read-only sibling: `settings/features.ts` deliberately never writes. The
 * write lives here so that stays true.
 *
 * @module settings/promote-spatial-canvas
 */

import type { FeaturesSettings } from '@memry/contracts/settings-schemas'
import type { DataDb } from '../database/types'
import { getSetting, setSetting } from '../database/queries/settings'
import { createLogger } from '../lib/logger'

const logger = createLogger('Settings:CanvasPromotion')

const FEATURES_KEY = 'features'

/** Set once the vault has been through the promotion, whatever the outcome. */
export const SPATIAL_CANVAS_PROMOTED_KEY = 'features.spatialCanvasPromoted'

export function promoteSpatialCanvas(db: DataDb): void {
  if (getSetting(db, SPATIAL_CANVAS_PROMOTED_KEY)) return

  const raw = getSetting(db, FEATURES_KEY)

  // No stored group at all (a fresh vault) — the read path already merges the
  // default, which is now on. Nothing to rewrite.
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<FeaturesSettings>

      // Only an explicit `false` needs rewriting. A missing key already reads
      // as on via the defaults merge, and `true` is where we want to be.
      if (parsed.spatialCanvas === false) {
        setSetting(db, FEATURES_KEY, JSON.stringify({ ...parsed, spatialCanvas: true }))
        logger.info('Promoted spatialCanvas to on for this vault')
      }
    } catch {
      // A corrupt blob reads as defaults — already on — so there is nothing to
      // promote. Fall through and mark it so this does not retry every open.
      logger.warn('Features settings unreadable; skipping canvas promotion')
    }
  }

  setSetting(db, SPATIAL_CANVAS_PROMOTED_KEY, '1')
}
